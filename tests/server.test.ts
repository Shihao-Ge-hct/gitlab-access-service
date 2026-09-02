import { createSign, generateKeyPairSync } from "node:crypto";
import { request } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { ServiceConfig } from "../src/config.js";
import { createServiceServer } from "../src/server.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const config: ServiceConfig = {
  baseUrl: new URL("https://gitlab.example.test"),
  project: "group/project",
  projectId: "group%2Fproject",
  port: 8080,
  token: "test-token",
  caPem: Buffer.from("test-ca"),
  caPath: "/run/secrets/gitlab-ca.crt",
  auth: {
    publicKeyPem: Buffer.from(
      publicKey.export({ type: "spki", format: "pem" }),
    ),
    publicKeyPath: "/run/secrets/auth-jwt-public-key.pem",
    issuer: "https://sso.example.test",
    audience: "gitlab-access-service",
  },
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

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function createToken(permissions: string[]): string {
  const header = encode({ alg: "RS256", typ: "JWT" });
  const claims = encode({
    iss: config.auth.issuer,
    aud: config.auth.audience,
    sub: "user-123",
    exp: Math.floor(Date.now() / 1000) + 300,
    permissions,
  });
  const data = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  return `${data}.${signer.sign(privateKey).toString("base64url")}`;
}

async function post(port: number, path: string, authorization?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const clientRequest = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: authorization ? { authorization } : undefined,
      },
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

  it("rejects an unauthenticated access check", async () => {
    const port = await start({
      config,
      gitlabClient: {
        checkAccess: async () => {
          throw new Error("should not be called");
        },
      },
    });

    const response = await post(port, "/v1/access/check");
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication failed.",
    });
  });

  it("rejects an authenticated caller without the required permission", async () => {
    const port = await start({
      config,
      gitlabClient: {
        checkAccess: async () => {
          throw new Error("should not be called");
        },
      },
    });

    const response = await post(
      port,
      "/v1/access/check",
      `Bearer ${createToken([])}`,
    );
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      code: "FORBIDDEN",
      message: "You do not have permission to perform this operation.",
    });
  });

  it("allows an authorized caller to run the access check", async () => {
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

    const response = await post(
      port,
      "/v1/access/check",
      `Bearer ${createToken(["gitlab.access.check"])}`,
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      gitlabReachable: true,
      project: "group/project",
      defaultBranch: "main",
    });
  });
});
