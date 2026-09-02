import { describe, expect, it } from "vitest";

import type { JobResponse } from "../src/contracts.js";
import {
  OperationConflictError,
  OperationCoordinator,
  OperationNotFoundError,
} from "../src/operation.js";
import type { GitLabApi } from "../src/gitlab-api.js";

function job(
  name: string,
  status: string,
  jobId = name.length,
): JobResponse {
  return {
    jobId,
    pipelineId: 42,
    name,
    status,
  };
}

function fakeClient(
  jobResponses: JobResponse[][],
  onPlay?: (jobId: number) => void,
): GitLabApi {
  return {
    checkAccess: async () => ({
      gitlabReachable: true,
      project: "group/project",
      defaultBranch: "main",
    }),
    createPipeline: async (request) => ({
      pipelineId: 42,
      pipelineUrl: "https://gitlab.example.test/pipelines/42",
      ref: request.ref,
      mode: request.mode,
      targetJobs: request.targetJobs,
    }),
    getPipeline: async () => ({ id: 42, status: "running", ref: "main" }),
    listPipelineJobs: async () =>
      jobResponses.shift() || jobResponses.at(-1) || [],
    playJob: async (jobId) => {
      onPlay?.(jobId);
      return job("test-unit-windows", "running", jobId);
    },
    getJobTrace: async () => "",
    getJobArtifacts: async () => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from(""),
    }),
  };
}

async function waitForFinal(
  coordinator: OperationCoordinator,
  operationId: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = coordinator.get(operationId);
    if (
      ["success", "failed", "canceled", "timed_out"].includes(
        operation.status,
      )
    ) {
      return operation;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Operation did not reach a final state.");
}

describe("OperationCoordinator", () => {
  it("creates a test operation and succeeds when all selected jobs succeed", async () => {
    const coordinator = new OperationCoordinator(
      fakeClient([
        [
          job("test-unit-windows", "success", 10),
          job("test-e2e-windows", "success", 11),
        ],
      ]),
      { pollIntervalMs: 0, timeoutMs: 1000 },
    );

    const created = await coordinator.start({
      mode: "test",
      ref: "v0.3.0",
      suites: ["unit", "e2e"],
    });
    const finished = await waitForFinal(coordinator, created.id);

    expect(finished.status).toBe("success");
    expect(finished.ref).toBe("v0.3.0");
    expect(finished.targetJobs).toEqual([
      "test-unit-windows",
      "test-e2e-windows",
    ]);
    expect(finished.jobs).toHaveLength(2);
  });

  it("starts manual jobs and waits for their final status", async () => {
    const played: number[] = [];
    const coordinator = new OperationCoordinator(
      fakeClient(
        [
          [job("test-unit-windows", "manual", 10)],
          [job("test-unit-windows", "success", 10)],
        ],
        (jobId) => played.push(jobId),
      ),
      { pollIntervalMs: 0, timeoutMs: 1000 },
    );

    const created = await coordinator.start({
      mode: "test",
      ref: "main",
      suites: ["unit"],
    });
    const finished = await waitForFinal(coordinator, created.id);

    expect(played).toEqual([10]);
    expect(finished.status).toBe("success");
  });

  it("marks the operation failed when a target job ends unsuccessfully", async () => {
    const coordinator = new OperationCoordinator(
      fakeClient([
        [
          job("test-rust-windows", "success", 10),
          job("test-unit-windows", "failed", 11),
          job("test-e2e-windows", "success", 12),
        ],
      ]),
      { pollIntervalMs: 0, timeoutMs: 1000 },
    );

    const created = await coordinator.start({
      mode: "test",
      ref: "main",
    });
    const finished = await waitForFinal(coordinator, created.id);

    expect(finished.status).toBe("failed");
    expect(finished.error).toBeUndefined();
  });

  it("times out when requested jobs never appear", async () => {
    let now = 0;
    const coordinator = new OperationCoordinator(
      fakeClient([[]]),
      {
        pollIntervalMs: 10,
        timeoutMs: 15,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    );

    const created = await coordinator.start({
      mode: "build",
      ref: "main",
    });
    const finished = await waitForFinal(coordinator, created.id);

    expect(finished.status).toBe("timed_out");
    expect(finished.error).toBe("Remote operation timed out.");
  });

  it("stops monitoring after cancellation and does not cancel GitLab remotely", async () => {
    let releaseList: (() => void) | undefined;
    const listPending = new Promise<JobResponse[]>((resolve) => {
      releaseList = () => resolve([]);
    });
    const client = fakeClient([]);
    client.listPipelineJobs = async () => listPending;
    const coordinator = new OperationCoordinator(client, {
      pollIntervalMs: 0,
      timeoutMs: 1000,
    });

    const created = await coordinator.start({
      mode: "build",
      ref: "main",
    });
    const canceling = coordinator.cancel(created.id);
    expect(canceling.cancellationRequested).toBe(true);
    releaseList?.();
    const finished = await waitForFinal(coordinator, created.id);

    expect(finished.status).toBe("canceled");
    expect(finished.cancellationRequested).toBe(true);
  });

  it("rejects cancellation of an unknown or finished operation", async () => {
    const coordinator = new OperationCoordinator(
      fakeClient([
        [job("build-windows", "success", 10)],
      ]),
      { pollIntervalMs: 0, timeoutMs: 1000 },
    );
    expect(() => coordinator.get("missing")).toThrow(OperationNotFoundError);
    const created = await coordinator.start({ mode: "build", ref: "main" });
    await waitForFinal(coordinator, created.id);
    expect(() => coordinator.cancel(created.id)).toThrow(
      OperationConflictError,
    );
  });
});
