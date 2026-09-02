import { request as httpsRequest, type RequestOptions } from "node:https";

import type { AccessCheckResponse } from "./contracts.js";
import type { ServiceConfig } from "./config.js";

export interface GitLabResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface GitLabTransport {
  request(
    path: string,
    options?: {
      method?: "GET" | "POST";
      body?: unknown;
      binary?: boolean;
    },
  ): Promise<GitLabResponse>;
}

export class GitLabUpstreamError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "GitLabUpstreamError";
    this.statusCode = statusCode;
  }
}

export function buildGitLabRequestOptions(
  config: ServiceConfig,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: Buffer,
): RequestOptions {
  return {
    protocol: config.baseUrl.protocol,
    hostname: config.baseUrl.hostname,
    port: config.baseUrl.port || 443,
    path,
    method,
    ca: config.caPem,
    rejectUnauthorized: true,
    headers: {
      Accept: "application/json",
      "PRIVATE-TOKEN": config.token,
      "User-Agent": "gitlab-access-service",
      ...(body
        ? {
            "Content-Type": "application/json",
            "Content-Length": body.byteLength,
          }
        : {}),
    },
  };
}

export class NodeHttpsTransport implements GitLabTransport {
  constructor(private readonly config: ServiceConfig) {}

  request(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      binary?: boolean;
    } = {},
  ): Promise<GitLabResponse> {
    const payload =
      options.body === undefined
        ? undefined
        : Buffer.from(JSON.stringify(options.body));
    const requestOptions = buildGitLabRequestOptions(
      this.config,
      path,
      options.method || "GET",
      payload,
    );
    if (options.binary) {
      requestOptions.headers = {
        ...requestOptions.headers,
        Accept: "application/octet-stream",
      };
    }

    return new Promise((resolve, reject) => {
      const request = httpsRequest(requestOptions, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      });
      request.setTimeout(15_000, () => {
        request.destroy(new Error("GitLab request timed out."));
      });
      request.on("error", reject);
      if (payload) {
        request.write(payload);
      }
      request.end();
    });
  }
}

export class GitLabClient {
  constructor(
    private readonly config: ServiceConfig,
    private readonly transport: GitLabTransport = new NodeHttpsTransport(config),
  ) {}

  async checkAccess(): Promise<AccessCheckResponse> {
    await this.requestJson("/api/v4/user");
    const project = await this.requestJson(
      `/api/v4/projects/${this.config.projectId}`,
    );
    const projectRecord =
      project && typeof project === "object"
        ? (project as Record<string, unknown>)
        : null;
    if (
      !projectRecord ||
      typeof projectRecord.path_with_namespace !== "string" ||
      typeof projectRecord.default_branch !== "string"
    ) {
      throw new GitLabUpstreamError(
        200,
        "GitLab returned an invalid project response.",
      );
    }

    return {
      gitlabReachable: true,
      project: projectRecord.path_with_namespace,
      defaultBranch: projectRecord.default_branch,
    };
  }

  private async requestJson(path: string): Promise<unknown> {
    const response = await this.transport.request(path);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new GitLabUpstreamError(
        response.statusCode,
        `GitLab request failed with HTTP ${response.statusCode}.`,
      );
    }
    try {
      return JSON.parse(response.body.toString("utf8")) as unknown;
    } catch {
      throw new GitLabUpstreamError(
        response.statusCode,
        "GitLab returned an invalid JSON response.",
      );
    }
  }
}
