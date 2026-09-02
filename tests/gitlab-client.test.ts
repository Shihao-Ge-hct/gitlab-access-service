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

  constructor(private readonly responses: GitLabResponse[]) {}

  async request(path: string): Promise<GitLabResponse> {
    this.calls.push(path);
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
});
