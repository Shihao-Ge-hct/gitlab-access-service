import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  await writeFile(tokenPath, token, "utf8");
  await writeFile(caPath, ca, "utf8");
  return { tokenPath, caPath };
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
      GITLAB_TOKEN_FILE: files.tokenPath,
      GITLAB_CA_FILE: files.caPath,
      GITLAB_BASE_URL: "https://gitlab.example.test",
      GITLAB_PROJECT: "group/project",
      SERVICE_PORT: "18080",
    });

    expect(config.token).toBe("test-token");
    expect(config.caPath).toBe(files.caPath);
    expect(config.project).toBe("group/project");
    expect(config.projectId).toBe("group%2Fproject");
    expect(config.port).toBe(18080);
    expect(config.baseUrl.origin).toBe("https://gitlab.example.test");
  });

  it("rejects a missing Secret without exposing its path", () => {
    expect(() =>
      loadConfig({
        GITLAB_TOKEN_FILE: "C:\\private\\missing-token",
        GITLAB_CA_FILE: "C:\\private\\missing-ca.crt",
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
        GITLAB_TOKEN_FILE: files.tokenPath,
        GITLAB_CA_FILE: files.caPath,
      }),
    ).toThrow("GitLab token file is empty.");
  });

  it("rejects an invalid CA certificate", async () => {
    const files = await createConfigFiles("test-token\n", "not-a-certificate");
    expect(() =>
      loadConfig({
        GITLAB_TOKEN_FILE: files.tokenPath,
        GITLAB_CA_FILE: files.caPath,
      }),
    ).toThrow(ConfigError);
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
        GITLAB_TOKEN_FILE: files.tokenPath,
        GITLAB_CA_FILE: files.caPath,
        GITLAB_BASE_URL: baseUrl,
      }),
    ).toThrow(ConfigError);
  });
});
