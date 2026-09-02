export const TEST_SUITES = ["rust", "unit", "e2e"] as const;
export type TestSuite = (typeof TEST_SUITES)[number];

export const MODES = ["build", "test"] as const;
export type PipelineMode = (typeof MODES)[number];

export const JOB_BY_SUITE: Readonly<Record<TestSuite, string>> = Object.freeze({
  rust: "test-rust-windows",
  unit: "test-unit-windows",
  e2e: "test-e2e-windows",
});

export const BUILD_JOB = "build-windows";
export const ALL_TEST_SUITES: readonly TestSuite[] = TEST_SUITES;

export type CreatePipelineRequest =
  | {
      mode: "build";
      ref: string;
      suites?: never;
    }
  | {
      mode: "test";
      ref: string;
      suites?: readonly string[];
    };

export type NormalizedCreatePipelineRequest =
  | {
      mode: "build";
      ref: string;
      suites: null;
      targetJobs: readonly [typeof BUILD_JOB];
    }
  | {
      mode: "test";
      ref: string;
      suites: readonly TestSuite[];
      targetJobs: readonly string[];
    };

export type ServiceErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "UPSTREAM_UNAUTHORIZED"
  | "UPSTREAM_FORBIDDEN"
  | "UPSTREAM_NOT_FOUND"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_INVALID_RESPONSE"
  | "UPSTREAM_TIMEOUT";

export class ContractError extends Error {
  readonly code = "INVALID_REQUEST" as const;
  readonly status = 400 as const;

  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export interface ServiceErrorPayload {
  code: ServiceErrorCode;
  message: string;
  requestId?: string;
  retryAfterSeconds?: number;
}

export interface PipelineResponse {
  pipelineId: number;
  pipelineUrl: string;
  ref: string;
  mode: PipelineMode;
  targetJobs: readonly string[];
}

export interface JobResponse {
  jobId: number;
  pipelineId: number;
  name: string;
  status: string;
  webUrl?: string;
  ref?: string;
  sourceCommit?: string;
  createdAt?: string;
  finishedAt?: string;
}

export interface AccessCheckResponse {
  gitlabReachable: boolean;
  project: string;
  defaultBranch: string;
}

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,255}$/;

function validateRef(ref: unknown): asserts ref is string {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 256) {
    throw new ContractError("ref must be a non-empty string of at most 256 characters.");
  }

  if (
    !REF_PATTERN.test(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.endsWith(".") ||
    ref.endsWith("/") ||
    ref.includes("//")
  ) {
    throw new ContractError(
      "ref contains unsupported characters or Git ref syntax.",
    );
  }
}

function normalizeSuites(suites: readonly string[] | undefined): TestSuite[] {
  const requested = suites === undefined ? [...ALL_TEST_SUITES] : [...suites];

  if (requested.length === 0) {
    throw new ContractError("suites must contain at least one test suite.");
  }

  const normalized: TestSuite[] = [];
  for (const suite of requested) {
    if (!TEST_SUITES.includes(suite as TestSuite)) {
      throw new ContractError(
        `unknown test suite '${suite}'; expected rust, unit, or e2e.`,
      );
    }
    if (!normalized.includes(suite as TestSuite)) {
      normalized.push(suite as TestSuite);
    }
  }
  return normalized;
}

export function normalizeCreatePipelineRequest(
  request: unknown,
): NormalizedCreatePipelineRequest {
  if (request === null || typeof request !== "object") {
    throw new ContractError("request body must be a JSON object.");
  }

  const candidate = request as Record<string, unknown>;
  const mode = candidate.mode;
  const ref = candidate.ref;
  validateRef(ref);

  if (mode === "build") {
    if ("suites" in candidate && candidate.suites !== undefined) {
      throw new ContractError("suites is only supported when mode is test.");
    }
    return {
      mode,
      ref,
      suites: null,
      targetJobs: [BUILD_JOB],
    };
  }

  if (mode === "test") {
    const suites = candidate.suites;
    if (
      suites !== undefined &&
      (!Array.isArray(suites) ||
        suites.some((suite) => typeof suite !== "string"))
    ) {
      throw new ContractError("suites must be an array of strings.");
    }
    const normalizedSuites = normalizeSuites(suites as string[] | undefined);
    return {
      mode,
      ref,
      suites: normalizedSuites,
      targetJobs: normalizedSuites.map((suite) => JOB_BY_SUITE[suite]),
    };
  }

  throw new ContractError("mode must be either 'build' or 'test'.");
}

export function isAllowedJobName(name: unknown): name is
  | typeof BUILD_JOB
  | (typeof JOB_BY_SUITE)[TestSuite] {
  return (
    name === BUILD_JOB ||
    (typeof name === "string" &&
      Object.values(JOB_BY_SUITE).includes(name))
  );
}

export function mapUpstreamStatus(status: number): ServiceErrorCode | null {
  if (status === 401) return "UPSTREAM_UNAUTHORIZED";
  if (status === 403) return "UPSTREAM_FORBIDDEN";
  if (status === 404) return "UPSTREAM_NOT_FOUND";
  if (status === 429) return "UPSTREAM_RATE_LIMITED";
  if (status >= 500 && status <= 599) return "UPSTREAM_UNAVAILABLE";
  return null;
}
