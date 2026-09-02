import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { rootCertificates } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";

const tempDirectories: string[] = [];

async function createConfigFiles(token = "test-token\n", ca = rootCertificates[0]) {
  const directory = await mkdtemp(join(tmpdir(), "gitlab-access-service-"));
  tempDirectories.push(directory);
  const tokenPath = join(directory, "gitlab-token");
  const caPath = join(directory, "gitlab-ca.crt");
  const authPublicKeyPath = join(directory, "auth-jwt-public-key.pem");
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(tokenPath, token, "utf8");
  await writeFile(caPath, ca, "utf8");
  await writeFile(
    authPublicKeyPath,
    publicKey.export({ type: "spki", format: "pem" }),
    "utf8",
  );
  return { tokenPath, caPath, authPublicKeyPath };
}

function environment(
  files: Awaited<ReturnType<typeof createConfigFiles>>,
) {
  return {
    GITLAB_TOKEN_FILE: files.tokenPath,
    GITLAB_CA_FILE: files.caPath,
    AUTH_MODE: "jwt",
    AUTH_JWT_PUBLIC_KEY_FILE: files.authPublicKeyPath,
    AUTH_JWT_ISSUER: "https://sso.example.test",
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("loadConfig", () => {
  it("reads and validates Docker Secret files", async () => {
    const files = await createConfigFiles();
    const config = loadConfig({
      ...environment(files),
      GITLAB_BASE_URL: "https://gitlab.example.test",
      GITLAB_PROJECT: "group/project",
      GITLAB_PIPELINE_REF: "ci-config",
      PIPELINE_POLL_SECONDS: "5",
      PIPELINE_TIMEOUT_MINUTES: "30",
      SERVICE_PORT: "18080",
    });

    expect(config.token).toBe("test-token");
    expect(config.caPath).toBe(files.caPath);
    expect(config.project).toBe("group/project");
    expect(config.projectId).toBe("group%2Fproject");
    expect(config.pipelineRef).toBe("ci-config");
    expect(config.pollSeconds).toBe(5);
    expect(config.timeoutMinutes).toBe(30);
    expect(config.port).toBe(18080);
    expect(config.baseUrl.origin).toBe("https://gitlab.example.test");
    expect(config.auth.mode).toBe("jwt");
    expect(config.auth.issuer).toBe("https://sso.example.test");
    expect(config.auth.audience).toBe("gitlab-access-service");
  });

  it("defaults to network-trust without requiring JWT settings", async () => {
    const files = await createConfigFiles();
    const config = loadConfig({
      GITLAB_TOKEN_FILE: files.tokenPath,
      GITLAB_CA_FILE: files.caPath,
    });

    expect(config.auth).toEqual({ mode: "network-trust" });
  });

  it("rejects an unsupported auth mode", async () => {
    const files = await createConfigFiles();
    expect(() =>
      loadConfig({
        GITLAB_TOKEN_FILE: files.tokenPath,
        GITLAB_CA_FILE: files.caPath,
        AUTH_MODE: "none",
      }),
    ).toThrow("AUTH_MODE must be either network-trust or jwt.");
  });

  it("rejects a missing Secret without exposing its path", () => {
    expect(() =>
      loadConfig({
        ...environment({
          tokenPath: "C:\\private\\missing-token",
          caPath: "C:\\private\\missing-ca.crt",
          authPublicKeyPath: "C:\\private\\missing-key.pem",
        }),
      }),
    ).toThrow("Could not read GitLab token file.");
  });

  it("rejects a missing CA Secret without exposing its path", async () => {
    const files = await createConfigFiles();
    expect(() =>
      loadConfig({
        GITLAB_TOKEN_FILE: files.tokenPath,
        GITLAB_CA_FILE: join(files.caPath, "missing"),
      }),
    ).toThrow("Could not read GitLab CA file.");
  });

  it("rejects an empty token", async () => {
    const files = await createConfigFiles(" \n");
    expect(() =>
      loadConfig({
        ...environment(files),
      }),
    ).toThrow("GitLab token file is empty.");
  });

  it("rejects an invalid CA certificate", async () => {
    const files = await createConfigFiles("test-token\n", "not-a-certificate");
    expect(() =>
      loadConfig({
        ...environment(files),
      }),
    ).toThrow(ConfigError);
  });

  it("rejects an invalid auth JWT public key", async () => {
    const files = await createConfigFiles();
    await writeFile(files.authPublicKeyPath, "not-a-public-key", "utf8");
    expect(() =>
      loadConfig({
        ...environment(files),
      }),
    ).toThrow("Auth JWT public key is not valid.");
  });

  it("requires the auth JWT issuer", async () => {
    const files = await createConfigFiles();
    expect(() =>
      loadConfig({
        ...environment(files),
        AUTH_JWT_ISSUER: " ",
      }),
    ).toThrow("AUTH_JWT_ISSUER is required.");
  });

  it.each([
    "http://gitlab.example.test",
    "https://user:password@gitlab.example.test",
    "https://gitlab.example.test/api",
    "https://gitlab.example.test?token=secret",
  ])("rejects an unsafe GitLab URL: %s", async (baseUrl) => {
    const files = await createConfigFiles();
    expect(() =>
      loadConfig({
        ...environment(files),
        GITLAB_BASE_URL: baseUrl,
      }),
    ).toThrow(ConfigError);
  });
});
