import type {
  AccessCheckResponse,
  JobResponse,
  NormalizedCreatePipelineRequest,
} from "./contracts.js";
import type { GitLabResponse } from "./gitlab-client.js";

export interface GitLabApi {
  checkAccess(): Promise<AccessCheckResponse>;
  createPipeline(
    request: NormalizedCreatePipelineRequest,
  ): Promise<{
    pipelineId: number;
    pipelineUrl: string;
    ref: string;
    mode: "build" | "test";
    targetJobs: readonly string[];
  }>;
  getPipeline(pipelineId: number): Promise<Record<string, unknown>>;
  listPipelineJobs(pipelineId: number): Promise<JobResponse[]>;
  playJob(jobId: number): Promise<JobResponse>;
  getJobTrace(jobId: number): Promise<string>;
  getJobArtifacts(jobId: number): Promise<GitLabResponse>;
}
