import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { AccessCheckResponse } from "./contracts.js";
import { loadConfig, type ServiceConfig } from "./config.js";
import { GitLabClient } from "./gitlab-client.js";

interface ServerDependencies {
  config: ServiceConfig | null;
  configError?: string;
  gitlabClient?: {
    checkAccess(): Promise<AccessCheckResponse>;
  } | null;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function isGet(request: IncomingMessage): boolean {
  return request.method === "GET";
}

export function createServiceServer(dependencies: ServerDependencies) {
  const { config, configError } = dependencies;
  const gitlabClient =
    dependencies.gitlabClient ??
    (config ? new GitLabClient(config) : null);

  return createServer((request, response) => {
    if (request.url === "/health/live" && isGet(request)) {
      writeJson(response, 200, { status: "ok" });
      return;
    }

    if (request.url === "/health/ready" && isGet(request)) {
      if (configError || !config || !gitlabClient) {
        writeJson(response, 503, {
          status: "not_ready",
          code: "SERVICE_NOT_READY",
          message: "GitLab access is not ready.",
        });
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
        .catch(() => {
          writeJson(response, 503, {
            status: "not_ready",
            code: "UPSTREAM_UNAVAILABLE",
            message: "GitLab access is not ready.",
          });
        });
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
  gitlabClient?: { checkAccess(): Promise<AccessCheckResponse> } | null,
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
