import { rootCertificates } from "node:tls";

import { describe, expect, it } from "vitest";

import type { AccessCheckResponse } from "../src/contracts.js";
import type { ServiceConfig } from "../src/config.js";
import {
  buildGitLabRequestOptions,
  GitLabClient,
  GitLabUpstreamError,
  type GitLabResponse,
  type GitLabTransport,
} from "../src/gitlab-client.js";

const config: ServiceConfig = {
  baseUrl: new URL("https://gitlab.example.test"),
  project: "group/project",
  projectId: "group%2Fproject",
  pipelineRef: "main",
  pollSeconds: 10,
  timeoutMinutes: 120,
  port: 8080,
  token: "secret-token",
  caPem: Buffer.from(rootCertificates[0], "utf8"),
  caPath: "/run/secrets/gitlab-ca.crt",
  auth: {
    publicKeyPem: Buffer.from("test-public-key"),
    publicKeyPath: "/run/secrets/auth-jwt-public-key.pem",
    issuer: "https://sso.example.test",
    audience: "gitlab-access-service",
  },
};

class FakeTransport implements GitLabTransport {
  readonly calls: string[] = [];
  readonly options: Array<{
    method?: "GET" | "POST";
    body?: unknown;
    binary?: boolean;
  }> = [];

  constructor(private readonly responses: GitLabResponse[]) {}

  async request(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      binary?: boolean;
    } = {},
  ): Promise<GitLabResponse> {
    this.calls.push(path);
    this.options.push(options);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake response configured.");
    }
    return response;
  }
}

function jsonResponse(body: unknown, statusCode = 200): GitLabResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body), "utf8"),
  };
}

describe("GitLab HTTPS client", () => {
  it("builds strict TLS options with the Service secret", () => {
    const options = buildGitLabRequestOptions(
      config,
      "/api/v4/user",
      "GET",
    );

    expect(options.protocol).toBe("https:");
    expect(options.hostname).toBe("gitlab.example.test");
    expect(options.ca).toEqual(config.caPem);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.headers).toMatchObject({
      Accept: "application/json",
      "PRIVATE-TOKEN": "secret-token",
    });
  });

  it("creates a GitLab pipeline with the fixed CI ref and dynamic GitHub ref", async () => {
    const transport = new FakeTransport([
      jsonResponse({ id: 42, web_url: "https://gitlab.example.test/pipelines/42" }),
    ]);
    const result = await new GitLabClient(config, transport).createPipeline({
      mode: "build",
      ref: "v0.3.0",
      suites: null,
      targetJobs: ["build-windows"],
    });

    expect(result).toEqual({
      pipelineId: 42,
      pipelineUrl: "https://gitlab.example.test/pipelines/42",
      ref: "v0.3.0",
      mode: "build",
      targetJobs: ["build-windows"],
    });
    expect(transport.calls).toEqual([
      "/api/v4/projects/group%2Fproject/pipeline",
    ]);
    expect(transport.options[0]).toEqual({
      method: "POST",
      body: {
        ref: "main",
        variables: [{ key: "GITHUB_REF", value: "v0.3.0" }],
      },
    });
  });

  it("checks the GitLab user and configured project", async () => {
    const transport = new FakeTransport([
      jsonResponse({ username: "service-account" }),
      jsonResponse({
        path_with_namespace: "group/project",
        default_branch: "main",
      }),
    ]);
    const result = await new GitLabClient(config, transport).checkAccess();

    const expected: AccessCheckResponse = {
      gitlabReachable: true,
      project: "group/project",
      defaultBranch: "main",
    };
    expect(result).toEqual(expected);
    expect(transport.calls).toEqual([
      "/api/v4/user",
      "/api/v4/projects/group%2Fproject",
    ]);
  });

  it("converts an upstream HTTP error into a safe typed error", async () => {
    const transport = new FakeTransport([
      jsonResponse({ message: "forbidden" }, 403),
    ]);

    await expect(new GitLabClient(config, transport).checkAccess()).rejects.toEqual(
      expect.objectContaining<Partial<GitLabUpstreamError>>({
        name: "GitLabUpstreamError",
        statusCode: 403,
        message: "GitLab request failed with HTTP 403.",
      }),
    );
  });

  it("rejects an invalid project response", async () => {
    const transport = new FakeTransport([
      jsonResponse({ username: "service-account" }),
      jsonResponse({ path_with_namespace: "group/project" }),
    ]);

    await expect(new GitLabClient(config, transport).checkAccess()).rejects.toThrow(
      "invalid project response",
    );
  });

  it("lists only managed jobs and maps the response to the Service model", async () => {
    const transport = new FakeTransport([
      jsonResponse([
        {
          id: 10,
          name: "test-unit-windows",
          status: "running",
          web_url: "https://gitlab.example.test/jobs/10",
          ref: "main",
          commit: { id: "commit-10" },
          pipeline: { id: 42 },
        },
        {
          id: 11,
          name: "deploy-production",
          status: "manual",
          pipeline: { id: 42 },
        },
      ]),
    ]);

    await expect(
      new GitLabClient(config, transport).listPipelineJobs(42),
    ).resolves.toEqual([
      {
        jobId: 10,
        pipelineId: 42,
        name: "test-unit-windows",
        status: "running",
        webUrl: "https://gitlab.example.test/jobs/10",
        ref: "main",
        sourceCommit: "commit-10",
      },
    ]);
  });

  it("plays only a managed manual job", async () => {
    const transport = new FakeTransport([
      jsonResponse({
        id: 10,
        name: "test-unit-windows",
        status: "manual",
        pipeline: { id: 42 },
      }),
      jsonResponse({
        id: 10,
        name: "test-unit-windows",
        status: "running",
        pipeline: { id: 42 },
      }),
    ]);

    await expect(new GitLabClient(config, transport).playJob(10)).resolves.toMatchObject({
      jobId: 10,
      name: "test-unit-windows",
      status: "running",
    });
    expect(transport.options[1]).toEqual({ method: "POST" });
  });

  it("reads trace and artifacts only after validating the managed job", async () => {
    const transport = new FakeTransport([
      jsonResponse({
        id: 10,
        name: "test-unit-windows",
        status: "failed",
        pipeline: { id: 42 },
      }),
      {
        statusCode: 200,
        headers: { "content-type": "text/plain" },
        body: Buffer.from("trace output", "utf8"),
      },
      jsonResponse({
        id: 10,
        name: "test-unit-windows",
        status: "failed",
        pipeline: { id: 42 },
      }),
      {
        statusCode: 200,
        headers: { "content-type": "application/zip" },
        body: Buffer.from("zip bytes"),
      },
    ]);

    const client = new GitLabClient(config, transport);
    await expect(client.getJobTrace(10)).resolves.toBe("trace output");
    await expect(client.getJobArtifacts(10)).resolves.toMatchObject({
      body: Buffer.from("zip bytes"),
    });
    expect(transport.options).toEqual([
      {},
      { binary: true },
      {},
      { binary: true },
    ]);
  });

  it("rejects trying to play a job that is not manual", async () => {
    const transport = new FakeTransport([
      jsonResponse({
        id: 10,
        name: "test-unit-windows",
        status: "running",
        pipeline: { id: 42 },
      }),
    ]);

    await expect(new GitLabClient(config, transport).playJob(10)).rejects.toMatchObject({
      name: "GitLabUpstreamError",
      statusCode: 409,
    });
  });
});
