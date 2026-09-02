import { describe, expect, it } from "vitest";

import {
  BUILD_JOB,
  ContractError,
  JOB_BY_SUITE,
  isAllowedJobName,
  mapUpstreamStatus,
  normalizeCreatePipelineRequest,
} from "../src/contracts.js";

describe("create pipeline contract", () => {
  it("defaults test mode to all three Windows test jobs", () => {
    expect(normalizeCreatePipelineRequest({ mode: "test", ref: "main" })).toEqual(
      {
        mode: "test",
        ref: "main",
        suites: ["rust", "unit", "e2e"],
        targetJobs: [
          JOB_BY_SUITE.rust,
          JOB_BY_SUITE.unit,
          JOB_BY_SUITE.e2e,
        ],
      },
    );
  });

  it("deduplicates explicitly selected test suites while preserving order", () => {
    expect(
      normalizeCreatePipelineRequest({
        mode: "test",
        ref: "release/0.3",
        suites: ["unit", "e2e", "unit"],
      }),
    ).toMatchObject({
      suites: ["unit", "e2e"],
      targetJobs: ["test-unit-windows", "test-e2e-windows"],
    });
  });

  it("maps build mode only to the build job", () => {
    expect(
      normalizeCreatePipelineRequest({ mode: "build", ref: "v0.3.0" }),
    ).toEqual({
      mode: "build",
      ref: "v0.3.0",
      suites: null,
      targetJobs: [BUILD_JOB],
    });
  });

  it.each([
    null,
    {},
    { mode: "deploy", ref: "main" },
    { mode: "test", ref: "main", suites: [] },
    { mode: "test", ref: "main", suites: ["rust", "unknown"] },
    { mode: "build", ref: "main", suites: ["unit"] },
  ])("rejects invalid request: %j", (request) => {
    expect(() => normalizeCreatePipelineRequest(request)).toThrow(ContractError);
  });

  it.each([
    "",
    "feature with spaces",
    "../main",
    "main..backup",
    "main@{1}",
    "/main",
    "main/",
    "main//backup",
    "main\nnext",
  ])("rejects unsafe ref: %j", (ref) => {
    expect(() =>
      normalizeCreatePipelineRequest({ mode: "build", ref }),
    ).toThrow("ref");
  });
});

describe("job and upstream contracts", () => {
  it("allows only the four configured Windows jobs", () => {
    expect(isAllowedJobName("build-windows")).toBe(true);
    expect(isAllowedJobName("test-rust-windows")).toBe(true);
    expect(isAllowedJobName("test-unit-windows")).toBe(true);
    expect(isAllowedJobName("test-e2e-windows")).toBe(true);
    expect(isAllowedJobName("arbitrary-job")).toBe(false);
    expect(isAllowedJobName("deploy-production")).toBe(false);
  });

  it.each([
    [401, "UPSTREAM_UNAUTHORIZED"],
    [403, "UPSTREAM_FORBIDDEN"],
    [404, "UPSTREAM_NOT_FOUND"],
    [429, "UPSTREAM_RATE_LIMITED"],
    [500, "UPSTREAM_UNAVAILABLE"],
    [503, "UPSTREAM_UNAVAILABLE"],
    [200, null],
  ] as const)("maps GitLab status %i to %s", (status, expected) => {
    expect(mapUpstreamStatus(status)).toBe(expected);
  });
});
