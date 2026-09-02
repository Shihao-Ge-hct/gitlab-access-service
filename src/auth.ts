import { createVerify } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import type { AuthConfig } from "./config.js";

export interface CallerIdentity {
  subject: string;
  permissions: readonly string[];
}

export class AuthenticationError extends Error {
  readonly status = 401 as const;
  readonly code = "UNAUTHENTICATED" as const;

  constructor() {
    super("Authentication failed.");
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends Error {
  readonly status = 403 as const;
  readonly code = "FORBIDDEN" as const;

  constructor() {
    super("You do not have permission to perform this operation.");
    this.name = "AuthorizationError";
  }
}

interface JwtHeader {
  alg?: unknown;
}

interface JwtClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  nbf?: unknown;
  permissions?: unknown;
}

function decodeJsonPart<T>(part: string): T {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
  } catch {
    throw new AuthenticationError();
  }
}

function decodeSignature(part: string): Buffer {
  try {
    const signature = Buffer.from(part, "base64url");
    if (signature.length === 0) {
      throw new AuthenticationError();
    }
    return signature;
  } catch {
    throw new AuthenticationError();
  }
}

function audienceMatches(audience: unknown, expected: string): boolean {
  if (typeof audience === "string") {
    return audience === expected;
  }
  return (
    Array.isArray(audience) &&
    audience.length > 0 &&
    audience.every((item) => typeof item === "string") &&
    audience.includes(expected)
  );
}

function parsePermissions(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((permission) => typeof permission !== "string" || !permission)
  ) {
    throw new AuthenticationError();
  }
  return [...new Set(value)];
}

function verifyClaims(
  claims: JwtClaims,
  config: AuthConfig,
  nowMs: number,
): CallerIdentity {
  const nowSeconds = Math.floor(nowMs / 1000);
  if (
    claims.iss !== config.issuer ||
    !audienceMatches(claims.aud, config.audience) ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= nowSeconds
  ) {
    throw new AuthenticationError();
  }
  if (
    claims.nbf !== undefined &&
    (typeof claims.nbf !== "number" ||
      !Number.isFinite(claims.nbf) ||
      claims.nbf > nowSeconds)
  ) {
    throw new AuthenticationError();
  }

  return {
    subject: claims.sub,
    permissions: parsePermissions(claims.permissions),
  };
}

export function verifyAccessToken(
  token: string,
  config: AuthConfig,
  nowMs = Date.now(),
): CallerIdentity {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new AuthenticationError();
  }

  const header = decodeJsonPart<JwtHeader>(parts[0]);
  if (header.alg !== "RS256") {
    throw new AuthenticationError();
  }

  const signature = decodeSignature(parts[2]);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  try {
    if (!verifier.verify(config.publicKeyPem, signature)) {
      throw new AuthenticationError();
    }
  } catch {
    throw new AuthenticationError();
  }

  return verifyClaims(
    decodeJsonPart<JwtClaims>(parts[1]),
    config,
    nowMs,
  );
}

export function authenticateRequest(
  headers: IncomingHttpHeaders,
  config: AuthConfig,
  nowMs = Date.now(),
): CallerIdentity {
  const authorization = headers.authorization;
  if (typeof authorization !== "string") {
    throw new AuthenticationError();
  }
  const match =
    /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
      authorization,
    );
  if (!match) {
    throw new AuthenticationError();
  }
  return verifyAccessToken(match[1], config, nowMs);
}

export function requirePermission(
  identity: CallerIdentity,
  permission: string,
): void {
  if (!identity.permissions.includes(permission)) {
    throw new AuthorizationError();
  }
}
