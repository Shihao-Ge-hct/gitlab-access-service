import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  authenticateRequest,
  requirePermission,
} from "./auth.js";
import {
  ContractError,
  mapUpstreamStatus,
  normalizeCreatePipelineRequest,
  type PipelineStatusResponse,
} from "./contracts.js";
import { loadConfig, type ServiceConfig } from "./config.js";
import type { GitLabApi } from "./gitlab-api.js";
import {
  GitLabClient,
  GitLabUpstreamError,
  type GitLabResponse,
} from "./gitlab-client.js";
import {
  OperationConflictError,
  OperationCoordinator,
  OperationNotFoundError,
} from "./operation.js";

const MAX_JSON_BODY_BYTES = 16 * 1024;

export interface ServerDependencies {
  config: ServiceConfig | null;
  configError?: string;
  gitlabClient?: GitLabApi | null;
  operationCoordinator?: OperationCoordinator | null;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: object,
): void {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function writeText(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function writeArtifact(
  response: ServerResponse,
  artifact: GitLabResponse,
  jobId: number,
): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/zip");
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="job-${jobId}-artifacts.zip"`,
  );
  response.setHeader("Content-Length", artifact.body.byteLength);
  response.end(artifact.body);
}

function routePath(request: IncomingMessage): string {
  try {
    return new URL(request.url || "/", "http://service.local").pathname;
  } catch {
    return "/";
  }
}

function drainRequest(request: IncomingMessage): void {
  request.resume();
}

function writeNotReady(response: ServerResponse): void {
  writeJson(response, 503, {
    status: "not_ready",
    code: "SERVICE_NOT_READY",
    message: "GitLab access is not ready.",
  });
}

function writeReadinessFailure(response: ServerResponse): void {
  writeJson(response, 503, {
    status: "not_ready",
    code: "UPSTREAM_UNAVAILABLE",
    message: "GitLab access is not ready.",
  });
}

function writeAuthFailure(
  request: IncomingMessage,
  response: ServerResponse,
  status: 401 | 403,
): void {
  drainRequest(request);
  writeJson(
    response,
    status,
    status === 401
      ? {
          code: "UNAUTHENTICATED",
          message: "Authentication failed.",
        }
      : {
          code: "FORBIDDEN",
          message: "You do not have permission to perform this operation.",
        },
  );
}

function authorizeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServiceConfig | null,
  permission: string,
): boolean {
  if (!config) {
    drainRequest(request);
    writeNotReady(response);
    return false;
  }

  try {
    const identity = authenticateRequest(request.headers, config.auth);
    requirePermission(identity, permission);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "status" in error &&
      error.status === 403
    ) {
      writeAuthFailure(request, response, 403);
      return false;
    }
    writeAuthFailure(request, response, 401);
    return false;
  }
}

function writeUpstreamFailure(
  response: ServerResponse,
  error: unknown,
): void {
  if (!(error instanceof GitLabUpstreamError)) {
    writeJson(response, 503, {
      code: "UPSTREAM_UNAVAILABLE",
      message: "GitLab is unavailable.",
    });
    return;
  }

  const code =
    mapUpstreamStatus(error.statusCode) || "UPSTREAM_INVALID_RESPONSE";
  const status =
    code === "UPSTREAM_NOT_FOUND"
      ? 404
      : code === "UPSTREAM_CONFLICT"
        ? 409
        : code === "UPSTREAM_RATE_LIMITED"
          ? 429
          : code === "UPSTREAM_UNAVAILABLE"
            ? 503
            : 502;
  writeJson(response, status, {
    code,
    message:
      code === "UPSTREAM_NOT_FOUND"
        ? "The requested GitLab resource was not found."
        : code === "UPSTREAM_CONFLICT"
          ? "The GitLab resource cannot be used in its current state."
          : code === "UPSTREAM_RATE_LIMITED"
            ? "GitLab rate limit reached."
            : code === "UPSTREAM_INVALID_RESPONSE"
              ? "GitLab returned an invalid response."
              : "GitLab request failed.",
  });
}

function writeOperationFailure(
  response: ServerResponse,
  error: unknown,
): void {
  if (error instanceof OperationNotFoundError) {
    writeJson(response, 404, {
      code: error.code,
      message: error.message,
    });
    return;
  }
  if (error instanceof OperationConflictError) {
    writeJson(response, 409, {
      code: error.code,
      message: error.message,
    });
    return;
  }
  writeUpstreamFailure(response, error);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  return new Promise((resolve, reject) => {
    request.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_JSON_BODY_BYTES) {
        request.removeAllListeners("data");
        request.resume();
        reject(new ContractError("Request body is too large."));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => {
      if (total === 0) {
        reject(new ContractError("Request body must be a JSON object."));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new ContractError("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ContractError("Resource id must be a positive integer.");
  }
  return id;
}

function serializePipeline(
  pipeline: Record<string, unknown>,
): PipelineStatusResponse {
  if (typeof pipeline.id !== "number" || typeof pipeline.status !== "string") {
    throw new GitLabUpstreamError(
      200,
      "GitLab returned an invalid pipeline response.",
    );
  }
  return {
    pipelineId: pipeline.id,
    status: pipeline.status,
    ...(typeof pipeline.ref === "string" ? { ref: pipeline.ref } : {}),
    ...(typeof pipeline.web_url === "string"
      ? { pipelineUrl: pipeline.web_url }
      : {}),
    ...(typeof pipeline.created_at === "string"
      ? { createdAt: pipeline.created_at }
      : {}),
    ...(typeof pipeline.updated_at === "string"
      ? { updatedAt: pipeline.updated_at }
      : {}),
    ...(typeof pipeline.finished_at === "string"
      ? { finishedAt: pipeline.finished_at }
      : {}),
  };
}

function redactTrace(trace: string, config: ServiceConfig): string {
  return trace
    .replaceAll(config.token, "<redacted>")
    .replaceAll("PRIVATE-TOKEN", "<redacted-header>");
}

export function createServiceServer(dependencies: ServerDependencies) {
  const { config, configError } = dependencies;
  const gitlabClient =
    dependencies.gitlabClient ??
    (config ? new GitLabClient(config) : null);
  const operationCoordinator =
    dependencies.operationCoordinator ??
    (config && gitlabClient
      ? new OperationCoordinator(gitlabClient, {
          pollIntervalMs: config.pollSeconds * 1000,
          timeoutMs: config.timeoutMinutes * 60 * 1000,
        })
      : null);

  return createServer((request, response) => {
    const path = routePath(request);

    if (path === "/health/live" && request.method === "GET") {
      writeJson(response, 200, { status: "ok" });
      return;
    }

    if (path === "/health/ready" && request.method === "GET") {
      if (configError || !config || !gitlabClient) {
        writeNotReady(response);
        return;
      }

      void gitlabClient
        .checkAccess()
        .then((access) => {
          writeJson(response, 200, {
            status: "ready",
            ...access,
          });
        })
        .catch(() => writeReadinessFailure(response));
      return;
    }

    if (path === "/v1/access/check" && request.method === "POST") {
      if (
        !authorizeRequest(
          request,
          response,
          config,
          "gitlab.access.check",
        )
      ) {
        return;
      }
      if (!gitlabClient) {
        writeNotReady(response);
        return;
      }

      void gitlabClient
        .checkAccess()
        .then((access) => writeJson(response, 200, access))
        .catch((error) => writeUpstreamFailure(response, error));
      return;
    }

    if (path === "/v1/pipelines" && request.method === "POST") {
      if (!authorizeRequest(request, response, config, "pipeline.create")) {
        return;
      }
      if (!gitlabClient) {
        writeNotReady(response);
        return;
      }

      void readJsonBody(request)
        .then((body) => normalizeCreatePipelineRequest(body))
        .then((pipelineRequest) => gitlabClient.createPipeline(pipelineRequest))
        .then((pipeline) => writeJson(response, 201, pipeline))
        .catch((error) => {
          if (error instanceof ContractError) {
            writeJson(response, 400, {
              code: "INVALID_REQUEST",
              message: error.message,
            });
            return;
          }
          writeUpstreamFailure(response, error);
        });
      return;
    }

    if (path === "/v1/runs" && request.method === "POST") {
      if (!authorizeRequest(request, response, config, "pipeline.create")) {
        return;
      }
      if (!operationCoordinator) {
        writeNotReady(response);
        return;
      }

      void readJsonBody(request)
        .then((body) => operationCoordinator.start(body))
        .then((operation) => writeJson(response, 202, operation))
        .catch((error) => {
          if (error instanceof ContractError) {
            writeJson(response, 400, {
              code: "INVALID_REQUEST",
              message: error.message,
            });
            return;
          }
          writeUpstreamFailure(response, error);
        });
      return;
    }

    const runCancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(path);
    if (runCancelMatch && request.method === "POST") {
      if (!authorizeRequest(request, response, config, "operation.cancel")) {
        return;
      }
      if (!operationCoordinator) {
        writeNotReady(response);
        return;
      }
      try {
        const operation = operationCoordinator.cancel(runCancelMatch[1]);
        writeJson(response, 202, operation);
      } catch (error) {
        writeOperationFailure(response, error);
      }
      return;
    }

    const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(path);
    if (runMatch && request.method === "GET") {
      if (!authorizeRequest(request, response, config, "job.read")) {
        return;
      }
      if (!operationCoordinator) {
        writeNotReady(response);
        return;
      }
      try {
        const operation = operationCoordinator.get(runMatch[1]);
        writeJson(response, 200, operation);
      } catch (error) {
        writeOperationFailure(response, error);
      }
      return;
    }

    const pipelineJobsMatch = /^\/v1\/pipelines\/(\d+)\/jobs$/.exec(path);
    if (pipelineJobsMatch && request.method === "GET") {
      if (!authorizeRequest(request, response, config, "job.read")) {
        return;
      }
      if (!gitlabClient) {
        writeNotReady(response);
        return;
      }
      let pipelineId: number;
      try {
        pipelineId = parseId(pipelineJobsMatch[1]);
      } catch (error) {
        writeJson(response, 400, {
          code: "INVALID_REQUEST",
          message:
            error instanceof Error ? error.message : "Invalid pipeline id.",
        });
        return;
      }
      void gitlabClient
        .listPipelineJobs(pipelineId)
        .then((jobs) => writeJson(response, 200, jobs))
        .catch((error) => writeUpstreamFailure(response, error));
      return;
    }

    const pipelineMatch = /^\/v1\/pipelines\/(\d+)$/.exec(path);
    if (pipelineMatch && request.method === "GET") {
      if (!authorizeRequest(request, response, config, "job.read")) {
        return;
      }
      if (!gitlabClient) {
        writeNotReady(response);
        return;
      }
      let pipelineId: number;
      try {
        pipelineId = parseId(pipelineMatch[1]);
      } catch (error) {
        writeJson(response, 400, {
          code: "INVALID_REQUEST",
          message:
            error instanceof Error ? error.message : "Invalid pipeline id.",
        });
        return;
      }
      void gitlabClient
        .getPipeline(pipelineId)
        .then(serializePipeline)
        .then((pipeline) => writeJson(response, 200, pipeline))
        .catch((error) => writeUpstreamFailure(response, error));
      return;
    }

    const jobPlayMatch = /^\/v1\/jobs\/(\d+)\/play$/.exec(path);
    if (jobPlayMatch && request.method === "POST") {
      if (!authorizeRequest(request, response, config, "job.play")) {
        return;
      }
      if (!gitlabClient) {
        writeNotReady(response);
        return;
      }
      let jobId: number;
      try {
        jobId = parseId(jobPlayMatch[1]);
      } catch (error) {
        writeJson(response, 400, {
          code: "INVALID_REQUEST",
          message: error instanceof Error ? error.message : "Invalid job id.",
        });
        return;
      }
      void gitlabClient
        .playJob(jobId)
        .then((job) => writeJson(response, 200, job))
        .catch((error) => writeUpstreamFailure(response, error));
      return;
    }

    const jobTraceMatch = /^\/v1\/jobs\/(\d+)\/trace$/.exec(path);
    if (jobTraceMatch && request.method === "GET") {
      if (!authorizeRequest(request, response, config, "job.trace.read")) {
        return;
      }
      if (!gitlabClient || !config) {
        writeNotReady(response);
        return;
      }
      let jobId: number;
      try {
        jobId = parseId(jobTraceMatch[1]);
      } catch (error) {
        writeJson(response, 400, {
          code: "INVALID_REQUEST",
          message: error instanceof Error ? error.message : "Invalid job id.",
        });
        return;
      }
      void gitlabClient
        .getJobTrace(jobId)
        .then((trace) => writeText(response, 200, redactTrace(trace, config)))
        .catch((error) => writeUpstreamFailure(response, error));
      return;
    }

    const jobArtifactsMatch = /^\/v1\/jobs\/(\d+)\/artifacts$/.exec(path);
    if (jobArtifactsMatch && request.method === "GET") {
      if (!authorizeRequest(request, response, config, "artifact.read")) {
        return;
      }
      if (!gitlabClient) {
        writeNotReady(response);
        return;
      }
      let jobId: number;
      try {
        jobId = parseId(jobArtifactsMatch[1]);
      } catch (error) {
        writeJson(response, 400, {
          code: "INVALID_REQUEST",
          message: error instanceof Error ? error.message : "Invalid job id.",
        });
        return;
      }
      void gitlabClient
        .getJobArtifacts(jobId)
        .then((artifact) => writeArtifact(response, artifact, jobId))
        .catch((error) => writeUpstreamFailure(response, error));
      return;
    }

    writeJson(response, 404, {
      code: "NOT_FOUND",
      message: "Route not found.",
    });
  });
}

export function startServer(
  config: ServiceConfig | null,
  configError?: string,
  gitlabClient?: GitLabApi | null,
) {
  const server = createServiceServer({ config, configError, gitlabClient });
  const port = config?.port || 8080;
  server.listen(port, "0.0.0.0", () => {
    console.log(`GitLab Access Service listening on port ${port}.`);
    if (configError) {
      console.error(`Service configuration is not ready: ${configError}`);
    }
  });
  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  let config: ServiceConfig | null = null;
  let configError: string | undefined;
  try {
    config = loadConfig();
  } catch (error) {
    configError =
      error instanceof Error
        ? error.message
        : "Service configuration could not be loaded.";
  }
  startServer(config, configError);
}
