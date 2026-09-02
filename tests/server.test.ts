import { request } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { ServiceConfig } from "../src/config.js";
import { createServiceServer } from "../src/server.js";

const config: ServiceConfig = {
  baseUrl: new URL("https://gitlab.example.test"),
  project: "group/project",
  projectId: "group%2Fproject",
  port: 8080,
  token: "test-token",
  caPem: Buffer.from("test-ca"),
  caPath: "/run/secrets/gitlab-ca.crt",
};

const servers: ReturnType<typeof createServiceServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        }),
    ),
  );
});

async function start(dependencies: Parameters<typeof createServiceServer>[0]) {
  const server = createServiceServer(dependencies);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address.");
  }
  return address.port;
}

async function get(port: number, path: string, method = "GET") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const clientRequest = request(
      { host: "127.0.0.1", port, path, method },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    clientRequest.on("error", reject);
    clientRequest.end();
  });
}

describe("health HTTP routes", () => {
  it("returns live without contacting GitLab", async () => {
    const port = await start({
      config,
      gitlabClient: {
        checkAccess: async () => {
          throw new Error("should not be called");
        },
      },
    });

    await expect(get(port, "/health/live")).resolves.toEqual({
      status: 200,
      body: '{"status":"ok"}',
    });
  });

  it("returns ready with the upstream access result", async () => {
    const port = await start({
      config,
      gitlabClient: {
        checkAccess: async () => ({
          gitlabReachable: true,
          project: "group/project",
          defaultBranch: "main",
        }),
      },
    });

    const response = await get(port, "/health/ready");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      status: "ready",
      gitlabReachable: true,
      project: "group/project",
      defaultBranch: "main",
    });
  });

  it("returns not ready when configuration is unavailable", async () => {
    const port = await start({
      config: null,
      configError: "GitLab token file is empty.",
    });

    const response = await get(port, "/health/ready");
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      status: "not_ready",
      code: "SERVICE_NOT_READY",
      message: "GitLab access is not ready.",
    });
  });

  it("returns not ready when GitLab access fails", async () => {
    const port = await start({
      config,
      gitlabClient: {
        checkAccess: async () => {
          throw new Error("upstream unavailable");
        },
      },
    });

    const response = await get(port, "/health/ready");
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      status: "not_ready",
      code: "UPSTREAM_UNAVAILABLE",
      message: "GitLab access is not ready.",
    });
  });

  it("does not expose unimplemented routes yet", async () => {
    const port = await start({ config });

    await expect(get(port, "/v1/pipelines")).resolves.toMatchObject({
      status: 404,
    });
    await expect(get(port, "/health/live", "POST")).resolves.toMatchObject({
      status: 404,
    });
  });
});
