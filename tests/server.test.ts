import { createSign, generateKeyPairSync } from "node:crypto";
import { request } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { ServiceConfig } from "../src/config.js";
import type { GitLabApi } from "../src/gitlab-api.js";
import {
  createServiceServer,
} from "../src/server.js";
import { OperationCoordinator } from "../src/operation.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const config: ServiceConfig = {
  baseUrl: new URL("https://gitlab.example.test"),
  project: "group/project",
  projectId: "group%2Fproject",
  pipelineRef: "main",
  pollSeconds: 10,
  timeoutMinutes: 120,
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

function fakeClient(overrides: Partial<GitLabApi> = {}): GitLabApi {
  const notImplemented = async () => {
    throw new Error("not implemented in this test");
  };
  return {
    checkAccess: async () => ({
      gitlabReachable: true,
      project: "group/project",
      defaultBranch: "main",
    }),
    createPipeline: notImplemented,
    getPipeline: notImplemented,
    listPipelineJobs: notImplemented,
    playJob: notImplemented,
    getJobTrace: notImplemented,
    getJobArtifacts: notImplemented,
    ...overrides,
  };
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

async function getWithHeaders(
  port: number,
  path: string,
  authorization: string,
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const clientRequest = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { authorization },
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

async function post(
  port: number,
  path: string,
  authorization?: string,
  body?: unknown,
) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
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
    if (payload) {
      clientRequest.setHeader("Content-Type", "application/json");
      clientRequest.setHeader("Content-Length", Buffer.byteLength(payload));
      clientRequest.write(payload);
    }
    clientRequest.end();
  });
}

describe("health HTTP routes", () => {
  it("returns live without contacting GitLab", async () => {
    const port = await start({
      config,
      gitlabClient: fakeClient({
        checkAccess: async () => {
          throw new Error("should not be called");
        },
      }),
    });

    await expect(get(port, "/health/live")).resolves.toEqual({
      status: 200,
      body: '{"status":"ok"}',
    });
  });

  it("returns ready with the upstream access result", async () => {
    const port = await start({
      config,
      gitlabClient: fakeClient({
        checkAccess: async () => ({
          gitlabReachable: true,
          project: "group/project",
          defaultBranch: "main",
        }),
      }),
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
      gitlabClient: fakeClient({
        checkAccess: async () => {
          throw new Error("upstream unavailable");
        },
      }),
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
      gitlabClient: fakeClient({
        checkAccess: async () => {
          throw new Error("should not be called");
        },
      }),
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
      gitlabClient: fakeClient({
        checkAccess: async () => {
          throw new Error("should not be called");
        },
      }),
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
      gitlabClient: fakeClient({
        checkAccess: async () => ({
          gitlabReachable: true,
          project: "group/project",
          defaultBranch: "main",
        }),
      }),
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

  it("creates a pipeline after validating the request body", async () => {
    let receivedRequest: unknown;
    const port = await start({
      config,
      gitlabClient: fakeClient({
        createPipeline: async (pipelineRequest) => {
          receivedRequest = pipelineRequest;
          return {
            pipelineId: 42,
            pipelineUrl: "https://gitlab.example.test/pipelines/42",
            ref: pipelineRequest.ref,
            mode: pipelineRequest.mode,
            targetJobs: pipelineRequest.targetJobs,
          };
        },
      }),
    });

    const response = await post(
      port,
      "/v1/pipelines",
      `Bearer ${createToken(["pipeline.create"])}`,
      { mode: "test", ref: "v0.3.0", suites: ["unit", "e2e"] },
    );
    expect(response.status).toBe(201);
    expect(receivedRequest).toEqual({
      mode: "test",
      ref: "v0.3.0",
      suites: ["unit", "e2e"],
      targetJobs: ["test-unit-windows", "test-e2e-windows"],
    });
    expect(JSON.parse(response.body)).toEqual({
      pipelineId: 42,
      pipelineUrl: "https://gitlab.example.test/pipelines/42",
      ref: "v0.3.0",
      mode: "test",
      targetJobs: ["test-unit-windows", "test-e2e-windows"],
    });
  });

  it("rejects invalid pipeline JSON with a contract error", async () => {
    const port = await start({
      config,
      gitlabClient: fakeClient(),
    });

    const response = await post(
      port,
      "/v1/pipelines",
      `Bearer ${createToken(["pipeline.create"])}`,
      { mode: "test", ref: "main", suites: ["unknown"] },
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      code: "INVALID_REQUEST",
      message: "unknown test suite 'unknown'; expected rust, unit, or e2e.",
    });
  });

  it("returns a sanitized pipeline and managed jobs", async () => {
    const port = await start({
      config,
      gitlabClient: fakeClient({
        getPipeline: async () => ({
          id: 42,
          status: "running",
          ref: "main",
          web_url: "https://gitlab.example.test/pipelines/42",
          created_at: "2026-09-02T03:00:00Z",
        }),
        listPipelineJobs: async () => [
          {
            jobId: 10,
            pipelineId: 42,
            name: "test-unit-windows",
            status: "running",
          },
        ],
      }),
    });

    const pipeline = await getWithHeaders(
      port,
      "/v1/pipelines/42",
      `Bearer ${createToken(["job.read"])}`,
    );
    expect(pipeline.status).toBe(200);
    expect(JSON.parse(pipeline.body)).toEqual({
      pipelineId: 42,
      status: "running",
      ref: "main",
      pipelineUrl: "https://gitlab.example.test/pipelines/42",
      createdAt: "2026-09-02T03:00:00Z",
    });

    const jobs = await getWithHeaders(
      port,
      "/v1/pipelines/42/jobs",
      `Bearer ${createToken(["job.read"])}`,
    );
    expect(jobs.status).toBe(200);
    expect(JSON.parse(jobs.body)).toEqual([
      {
        jobId: 10,
        pipelineId: 42,
        name: "test-unit-windows",
        status: "running",
      },
    ]);
  });

  it("requires the matching permission for pipeline and job operations", async () => {
    const port = await start({ config, gitlabClient: fakeClient() });

    await expect(
      get(port, "/v1/pipelines/42", "GET"),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      getWithHeaders(
        port,
        "/v1/pipelines/42",
        `Bearer ${createToken(["pipeline.create"])}`,
      ),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      post(port, "/v1/jobs/10/play", `Bearer ${createToken(["job.read"])}`),
    ).resolves.toMatchObject({ status: 403 });
  });

  it("plays a job and serves redacted trace and binary artifacts", async () => {
    const port = await start({
      config,
      gitlabClient: fakeClient({
        playJob: async () => ({
          jobId: 10,
          pipelineId: 42,
          name: "test-unit-windows",
          status: "running",
        }),
        getJobTrace: async () => "PRIVATE-TOKEN: test-token\nresult: failed",
        getJobArtifacts: async () => ({
          statusCode: 200,
          headers: { "content-type": "application/zip" },
          body: Buffer.from("zip bytes", "utf8"),
        }),
      }),
    });

    const played = await post(
      port,
      "/v1/jobs/10/play",
      `Bearer ${createToken(["job.play"])}`,
    );
    expect(played.status).toBe(200);
    expect(JSON.parse(played.body).status).toBe("running");

    const trace = await getWithHeaders(
      port,
      "/v1/jobs/10/trace",
      `Bearer ${createToken(["job.trace.read"])}`,
    );
    expect(trace.status).toBe(200);
    expect(trace.body).toContain("<redacted>");
    expect(trace.body).not.toContain("test-token");

    const artifacts = await getWithHeaders(
      port,
      "/v1/jobs/10/artifacts",
      `Bearer ${createToken(["artifact.read"])}`,
    );
    expect(artifacts.status).toBe(200);
    expect(artifacts.body).toBe("zip bytes");
  });

  it("starts a controlled run and exposes its current state", async () => {
    const client = fakeClient({
      createPipeline: async (pipelineRequest) => ({
        pipelineId: 42,
        pipelineUrl: "https://gitlab.example.test/pipelines/42",
        ref: pipelineRequest.ref,
        mode: pipelineRequest.mode,
        targetJobs: pipelineRequest.targetJobs,
      }),
      listPipelineJobs: async () => [
        {
          jobId: 10,
          pipelineId: 42,
          name: "build-windows",
          status: "success",
        },
      ],
    });
    const operationCoordinator = new OperationCoordinator(client, {
      pollIntervalMs: 0,
      timeoutMs: 1000,
      sleep: async () => {},
    });
    const port = await start({
      config,
      gitlabClient: client,
      operationCoordinator,
    });

    const created = await post(
      port,
      "/v1/runs",
      `Bearer ${createToken(["pipeline.create"])}`,
      { mode: "build", ref: "v0.3.0" },
    );
    expect(created.status).toBe(202);
    const createdOperation = JSON.parse(created.body);
    expect(createdOperation).toMatchObject({
      pipelineId: 42,
      ref: "v0.3.0",
      targetJobs: ["build-windows"],
    });

    const state = await getWithHeaders(
      port,
      `/v1/runs/${createdOperation.id}`,
      `Bearer ${createToken(["job.read"])}`,
    );
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({
      id: createdOperation.id,
      status: "success",
    });
  });

  it("allows canceling Service monitoring for an active run", async () => {
    let releaseList: (() => void) | undefined;
    const pendingJobs = new Promise<never[]>((resolve) => {
      releaseList = () => resolve([]);
    });
    const client = fakeClient({
      createPipeline: async (pipelineRequest) => ({
        pipelineId: 42,
        pipelineUrl: "https://gitlab.example.test/pipelines/42",
        ref: pipelineRequest.ref,
        mode: pipelineRequest.mode,
        targetJobs: pipelineRequest.targetJobs,
      }),
      listPipelineJobs: async () => pendingJobs,
    });
    const operationCoordinator = new OperationCoordinator(client, {
      pollIntervalMs: 0,
      timeoutMs: 1000,
    });
    const port = await start({
      config,
      gitlabClient: client,
      operationCoordinator,
    });

    const created = await post(
      port,
      "/v1/runs",
      `Bearer ${createToken(["pipeline.create"])}`,
      { mode: "build", ref: "main" },
    );
    const operationId = JSON.parse(created.body).id;
    const canceled = await post(
      port,
      `/v1/runs/${operationId}/cancel`,
      `Bearer ${createToken(["operation.cancel"])}`,
    );
    expect(canceled.status).toBe(202);
    expect(JSON.parse(canceled.body).cancellationRequested).toBe(true);
    releaseList?.();
  });

  it("rejects unknown run ids without contacting GitLab", async () => {
    const port = await start({
      config,
      gitlabClient: fakeClient(),
      operationCoordinator: new OperationCoordinator(fakeClient()),
    });

    const response = await getWithHeaders(
      port,
      "/v1/runs/missing",
      `Bearer ${createToken(["job.read"])}`,
    );
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      code: "OPERATION_NOT_FOUND",
      message: "Remote operation was not found.",
    });
  });
});
