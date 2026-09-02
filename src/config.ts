import { readFileSync } from "node:fs";
import { createPublicKey, X509Certificate } from "node:crypto";

export const DEFAULT_BASE_URL = "https://gitlab.hc.com";
export const DEFAULT_PROJECT = "infras/ai_infra/gitKrab";
export const DEFAULT_PIPELINE_REF = "main";
export const DEFAULT_POLL_SECONDS = 10;
export const DEFAULT_TIMEOUT_MINUTES = 120;
export const DEFAULT_PORT = 8080;
export const DEFAULT_TOKEN_FILE = "/run/secrets/gitlab-token";
export const DEFAULT_CA_FILE = "/run/secrets/gitlab-ca.crt";
export const DEFAULT_AUTH_PUBLIC_KEY_FILE =
  "/run/secrets/auth-jwt-public-key.pem";
export const DEFAULT_AUTH_AUDIENCE = "gitlab-access-service";

export interface AuthConfig {
  publicKeyPem: Buffer;
  publicKeyPath: string;
  issuer: string;
  audience: string;
}

export interface ServiceConfig {
  baseUrl: URL;
  project: string;
  projectId: string;
  pipelineRef: string;
  pollSeconds: number;
  timeoutMinutes: number;
  port: number;
  token: string;
  caPem: Buffer;
  caPath: string;
  auth: AuthConfig;
}

export class ConfigError extends Error {
  readonly safeMessage: string;

  constructor(safeMessage: string) {
    super(safeMessage);
    this.name = "ConfigError";
    this.safeMessage = safeMessage;
  }
}

export interface ConfigEnvironment {
  GITLAB_BASE_URL?: string;
  GITLAB_PROJECT?: string;
  GITLAB_PIPELINE_REF?: string;
  PIPELINE_POLL_SECONDS?: string;
  PIPELINE_TIMEOUT_MINUTES?: string;
  GITLAB_TOKEN_FILE?: string;
  GITLAB_CA_FILE?: string;
  SERVICE_PORT?: string;
  AUTH_JWT_PUBLIC_KEY_FILE?: string;
  AUTH_JWT_ISSUER?: string;
  AUTH_JWT_AUDIENCE?: string;
}

function readRequiredFile(path: string, description: string): Buffer {
  try {
    const contents = readFileSync(path);
    if (contents.length === 0) {
      throw new ConfigError(`${description} file is empty.`);
    }
    return contents;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(`Could not read ${description} file.`);
  }
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? DEFAULT_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("SERVICE_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function parsePositiveNumber(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  const parsed = value === undefined ? defaultValue : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new ConfigError(`${name} must be at least 1.`);
  }
  return parsed;
}

function parseBaseUrl(value: string | undefined): URL {
  let baseUrl: URL;
  try {
    baseUrl = new URL(value || DEFAULT_BASE_URL);
  } catch {
    throw new ConfigError("GITLAB_BASE_URL must be a valid HTTPS URL.");
  }
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password) {
    throw new ConfigError("GITLAB_BASE_URL must use HTTPS without embedded credentials.");
  }
  if (baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
    throw new ConfigError("GITLAB_BASE_URL must contain only the GitLab origin.");
  }
  return baseUrl;
}

function parseProject(value: string | undefined): string {
  const project = (value || DEFAULT_PROJECT).trim();
  if (!project || project.startsWith("/") || project.endsWith("/")) {
    throw new ConfigError("GITLAB_PROJECT must be a non-empty project path.");
  }
  if (project.includes("\\") || project.includes("..") || /[\u0000-\u001f]/.test(project)) {
    throw new ConfigError("GITLAB_PROJECT contains unsupported characters.");
  }
  return project;
}

function parseRequiredSetting(
  value: string | undefined,
  message: string,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new ConfigError(message);
  }
  return normalized;
}

export function loadConfig(
  environment: ConfigEnvironment = process.env,
): ServiceConfig {
  const tokenPath = environment.GITLAB_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  const caPath = environment.GITLAB_CA_FILE || DEFAULT_CA_FILE;
  const authPublicKeyPath =
    environment.AUTH_JWT_PUBLIC_KEY_FILE || DEFAULT_AUTH_PUBLIC_KEY_FILE;
  const token = readRequiredFile(tokenPath, "GitLab token").toString("utf8").trim();
  if (!token) {
    throw new ConfigError("GitLab token file is empty.");
  }

  const caPem = readRequiredFile(caPath, "GitLab CA");
  try {
    new X509Certificate(caPem);
  } catch {
    throw new ConfigError("GitLab CA file is not a valid X.509 certificate.");
  }

  const authPublicKeyPem = readRequiredFile(
    authPublicKeyPath,
    "auth JWT public key",
  );
  try {
    createPublicKey(authPublicKeyPem);
  } catch {
    throw new ConfigError("Auth JWT public key is not valid.");
  }
  const issuer = parseRequiredSetting(
    environment.AUTH_JWT_ISSUER,
    "AUTH_JWT_ISSUER is required.",
  );
  const audience =
    environment.AUTH_JWT_AUDIENCE?.trim() || DEFAULT_AUTH_AUDIENCE;

  const project = parseProject(environment.GITLAB_PROJECT);
  const pipelineRef = parseRequiredSetting(
    environment.GITLAB_PIPELINE_REF || DEFAULT_PIPELINE_REF,
    "GITLAB_PIPELINE_REF must be a non-empty ref.",
  );
  return {
    baseUrl: parseBaseUrl(environment.GITLAB_BASE_URL),
    project,
    projectId: encodeURIComponent(project),
    pipelineRef,
    pollSeconds: parsePositiveNumber(
      environment.PIPELINE_POLL_SECONDS,
      DEFAULT_POLL_SECONDS,
      "PIPELINE_POLL_SECONDS",
    ),
    timeoutMinutes: parsePositiveNumber(
      environment.PIPELINE_TIMEOUT_MINUTES,
      DEFAULT_TIMEOUT_MINUTES,
      "PIPELINE_TIMEOUT_MINUTES",
    ),
    port: parsePort(environment.SERVICE_PORT),
    token,
    caPem,
    caPath,
    auth: {
      publicKeyPem: authPublicKeyPem,
      publicKeyPath: authPublicKeyPath,
      issuer,
      audience,
    },
  };
}
