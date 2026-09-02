import { request as httpsRequest, type RequestOptions } from "node:https";

import type {
  AccessCheckResponse,
  JobResponse,
  NormalizedCreatePipelineRequest,
  PipelineResponse,
} from "./contracts.js";
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

  async createPipeline(
    request: NormalizedCreatePipelineRequest,
  ): Promise<PipelineResponse> {
    const pipeline = await this.requestJson(
      `/api/v4/projects/${this.config.projectId}/pipeline`,
      {
        method: "POST",
        body: {
          ref: this.config.pipelineRef,
          variables: [{ key: "GITHUB_REF", value: request.ref }],
        },
      },
    );
    const record = asRecord(pipeline);
    if (
      typeof record?.id !== "number" ||
      typeof record.web_url !== "string"
    ) {
      throw new GitLabUpstreamError(
        200,
        "GitLab returned an invalid pipeline response.",
      );
    }
    return {
      pipelineId: record.id,
      pipelineUrl: record.web_url,
      ref: request.ref,
      mode: request.mode,
      targetJobs: request.targetJobs,
    };
  }

  async getPipeline(pipelineId: number): Promise<Record<string, unknown>> {
    const pipeline = await this.requestJson(
      `/api/v4/projects/${this.config.projectId}/pipelines/${pipelineId}`,
    );
    const record = asRecord(pipeline);
    if (!record || typeof record.id !== "number") {
      throw new GitLabUpstreamError(
        200,
        "GitLab returned an invalid pipeline response.",
      );
    }
    return record;
  }

  async listPipelineJobs(pipelineId: number): Promise<JobResponse[]> {
    const jobs = await this.requestJson(
      `/api/v4/projects/${this.config.projectId}/pipelines/${pipelineId}/jobs?per_page=100&include_retried=false`,
    );
    if (!Array.isArray(jobs)) {
      throw new GitLabUpstreamError(
        200,
        "GitLab returned an invalid jobs response.",
      );
    }
    return jobs.filter(isAllowedJobRecord).map(toJobResponse);
  }

  async getJob(jobId: number): Promise<JobResponse> {
    const job = await this.requestJson(
      `/api/v4/projects/${this.config.projectId}/jobs/${jobId}`,
    );
    if (!isJobRecord(job)) {
      throw new GitLabUpstreamError(
        200,
        "GitLab returned an invalid job response.",
      );
    }
    if (!isAllowedJobRecord(job)) {
      throw new GitLabUpstreamError(
        404,
        "GitLab job is not managed by this Service.",
      );
    }
    return toJobResponse(job);
  }

  async playJob(jobId: number): Promise<JobResponse> {
    const job = await this.getJob(jobId);
    if (job.status !== "manual") {
      throw new GitLabUpstreamError(
        409,
        "GitLab job is not waiting for manual start.",
      );
    }
    const played = await this.requestJson(
      `/api/v4/projects/${this.config.projectId}/jobs/${jobId}/play`,
      { method: "POST" },
    );
    if (!isAllowedJobRecord(played)) {
      throw new GitLabUpstreamError(
        200,
        "GitLab returned an invalid job response after play.",
      );
    }
    return toJobResponse(played);
  }

  async getJobTrace(jobId: number): Promise<string> {
    await this.getJob(jobId);
    const response = await this.transport.request(
      `/api/v4/projects/${this.config.projectId}/jobs/${jobId}/trace`,
      { binary: true },
    );
    this.assertSuccess(response);
    return response.body.toString("utf8");
  }

  async getJobArtifacts(jobId: number): Promise<GitLabResponse> {
    await this.getJob(jobId);
    const response = await this.transport.request(
      `/api/v4/projects/${this.config.projectId}/jobs/${jobId}/artifacts`,
      { binary: true },
    );
    this.assertSuccess(response);
    return response;
  }

  private async requestJson(
    path: string,
    options?: {
      method?: "GET" | "POST";
      body?: unknown;
    },
  ): Promise<unknown> {
    const response = await this.transport.request(path, options);
    this.assertSuccess(response);
    try {
      return JSON.parse(response.body.toString("utf8")) as unknown;
    } catch {
      throw new GitLabUpstreamError(
        response.statusCode,
        "GitLab returned an invalid JSON response.",
      );
    }
  }

  private assertSuccess(response: GitLabResponse): void {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new GitLabUpstreamError(
        response.statusCode,
        `GitLab request failed with HTTP ${response.statusCode}.`,
      );
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function isAllowedJobRecord(value: unknown): value is Record<string, unknown> {
  const record = asRecord(value);
  return (
    !!record &&
    typeof record.id === "number" &&
    typeof record.pipeline === "object" &&
    record.pipeline !== null &&
    typeof (record.pipeline as Record<string, unknown>).id === "number" &&
    typeof record.name === "string" &&
    typeof record.status === "string" &&
    [
      "build-windows",
      "test-rust-windows",
      "test-unit-windows",
      "test-e2e-windows",
    ].includes(record.name)
  );
}

function isJobRecord(value: unknown): value is Record<string, unknown> {
  const record = asRecord(value);
  return (
    !!record &&
    typeof record.id === "number" &&
    typeof record.pipeline === "object" &&
    record.pipeline !== null &&
    typeof (record.pipeline as Record<string, unknown>).id === "number" &&
    typeof record.name === "string" &&
    typeof record.status === "string"
  );
}

function toJobResponse(record: Record<string, unknown>): JobResponse {
  const pipeline = record.pipeline as Record<string, unknown>;
  return {
    jobId: record.id as number,
    pipelineId: pipeline.id as number,
    name: record.name as string,
    status: record.status as string,
    ...(typeof record.web_url === "string" ? { webUrl: record.web_url } : {}),
    ...(typeof record.ref === "string" ? { ref: record.ref } : {}),
    ...(typeof record.commit === "object" &&
    record.commit !== null &&
    typeof (record.commit as Record<string, unknown>).id === "string"
      ? { sourceCommit: (record.commit as Record<string, unknown>).id as string }
      : {}),
    ...(typeof record.created_at === "string"
      ? { createdAt: record.created_at }
      : {}),
    ...(typeof record.finished_at === "string"
      ? { finishedAt: record.finished_at }
      : {}),
  };
}
