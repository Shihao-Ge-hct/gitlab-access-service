import { randomUUID } from "node:crypto";

import type {
  JobResponse,
  NormalizedCreatePipelineRequest,
} from "./contracts.js";
import { normalizeCreatePipelineRequest } from "./contracts.js";
import type { GitLabApi } from "./gitlab-api.js";

export const OPERATION_FINAL_STATUSES = [
  "success",
  "failed",
  "canceled",
  "timed_out",
] as const;
export type OperationStatus =
  | "created"
  | "running"
  | (typeof OPERATION_FINAL_STATUSES)[number];

export interface RemoteOperation {
  id: string;
  mode: "build" | "test";
  ref: string;
  targetJobs: readonly string[];
  pipelineId: number;
  pipelineUrl: string;
  status: OperationStatus;
  jobs: readonly JobResponse[];
  cancellationRequested: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
}

export class OperationNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = "OPERATION_NOT_FOUND" as const;

  constructor() {
    super("Remote operation was not found.");
    this.name = "OperationNotFoundError";
  }
}

export class OperationConflictError extends Error {
  readonly status = 409 as const;
  readonly code = "OPERATION_CONFLICT" as const;

  constructor() {
    super("Remote operation has already finished.");
    this.name = "OperationConflictError";
  }
}

export interface OperationCoordinatorOptions {
  pollIntervalMs: number;
  timeoutMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_OPTIONS: OperationCoordinatorOptions = {
  pollIntervalMs: 10_000,
  timeoutMs: 120 * 60 * 1000,
};

export class OperationCoordinator {
  private readonly operations = new Map<string, RemoteOperation>();
  private readonly options: OperationCoordinatorOptions;

  constructor(
    private readonly gitlabClient: GitLabApi,
    options: Partial<OperationCoordinatorOptions> = {},
  ) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      now: options.now || DEFAULT_OPTIONS.now || (() => Date.now()),
      sleep:
        options.sleep ||
        DEFAULT_OPTIONS.sleep ||
        ((milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds))),
    };
  }

  async start(request: unknown): Promise<RemoteOperation> {
    const normalized = normalizeCreatePipelineRequest(request);
    return this.startNormalized(normalized);
  }

  get(operationId: string): RemoteOperation {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new OperationNotFoundError();
    }
    return cloneOperation(operation);
  }

  cancel(operationId: string): RemoteOperation {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new OperationNotFoundError();
    }
    if (isFinal(operation.status)) {
      throw new OperationConflictError();
    }
    operation.cancellationRequested = true;
    operation.updatedAt = this.timestamp();
    return cloneOperation(operation);
  }

  private async startNormalized(
    request: NormalizedCreatePipelineRequest,
  ): Promise<RemoteOperation> {
    const pipeline = await this.gitlabClient.createPipeline(request);
    const timestamp = this.timestamp();
    const operation: RemoteOperation = {
      id: randomUUID(),
      mode: request.mode,
      ref: request.ref,
      targetJobs: request.targetJobs,
      pipelineId: pipeline.pipelineId,
      pipelineUrl: pipeline.pipelineUrl,
      status: "created",
      jobs: [],
      cancellationRequested: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.operations.set(operation.id, operation);
    void this.monitor(operation.id);
    return cloneOperation(operation);
  }

  private async monitor(operationId: string): Promise<void> {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return;
    }

    operation.status = "running";
    operation.updatedAt = this.timestamp();
    const deadline = this.now() + this.options.timeoutMs;

    while (this.now() < deadline) {
      if (operation.cancellationRequested) {
        this.finish(operation, "canceled");
        return;
      }

      try {
        const jobs = await this.gitlabClient.listPipelineJobs(
          operation.pipelineId,
        );
        operation.jobs = jobs;
        operation.updatedAt = this.timestamp();

        for (const targetName of operation.targetJobs) {
          const job = jobs.find((item) => item.name === targetName);
          if (job?.status === "manual") {
            const started = await this.gitlabClient.playJob(job.jobId);
            operation.jobs = replaceJob(operation.jobs, started);
            operation.updatedAt = this.timestamp();
          }
        }

        if (allTargetJobsFinal(operation)) {
          const successful = operation.targetJobs.every((targetName) =>
            operation.jobs.some(
              (job) => job.name === targetName && job.status === "success",
            ),
          );
          this.finish(operation, successful ? "success" : "failed");
          return;
        }
      } catch {
        operation.error = "GitLab operation failed.";
        this.finish(operation, "failed");
        return;
      }

      await this.options.sleep?.(this.options.pollIntervalMs);
    }

    this.finish(operation, "timed_out", "Remote operation timed out.");
  }

  private finish(
    operation: RemoteOperation,
    status: Extract<OperationStatus, "success" | "failed" | "canceled" | "timed_out">,
    error?: string,
  ): void {
    operation.status = status;
    operation.error = error;
    operation.finishedAt = this.timestamp();
    operation.updatedAt = operation.finishedAt;
  }

  private now(): number {
    return (this.options.now || (() => Date.now()))();
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}

function isFinal(status: OperationStatus): boolean {
  return (OPERATION_FINAL_STATUSES as readonly string[]).includes(status);
}

function allTargetJobsFinal(operation: RemoteOperation): boolean {
  return operation.targetJobs.every((targetName) => {
    const job = operation.jobs.find((item) => item.name === targetName);
    return !!job && ["success", "failed", "canceled", "skipped", "blocked"].includes(job.status);
  });
}

function replaceJob(
  jobs: readonly JobResponse[],
  replacement: JobResponse,
): readonly JobResponse[] {
  return jobs.map((job) =>
    job.jobId === replacement.jobId ? replacement : job,
  );
}

function cloneOperation(operation: RemoteOperation): RemoteOperation {
  return {
    ...operation,
    targetJobs: [...operation.targetJobs],
    jobs: operation.jobs.map((job) => ({ ...job })),
  };
}
