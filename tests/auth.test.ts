import { createSign, generateKeyPairSync } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { describe, expect, it } from "vitest";

import {
  authenticateRequest,
  AuthenticationError,
  AuthorizationError,
  requirePermission,
  verifyAccessToken,
} from "../src/auth.js";
import type { AuthConfig } from "../src/config.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const authConfig: AuthConfig = {
  publicKeyPem: Buffer.from(
    publicKey.export({ type: "spki", format: "pem" }),
  ),
  publicKeyPath: "/run/secrets/auth-jwt-public-key.pem",
  issuer: "https://sso.example.test",
  audience: "gitlab-access-service",
};

const NOW = Date.UTC(2026, 8, 2, 3, 0, 0);

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function createToken(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = { alg: "RS256", typ: "JWT" },
): string {
  const encodedHeader = encode(header);
  const encodedClaims = encode({
    iss: authConfig.issuer,
    aud: authConfig.audience,
    sub: "user-123",
    exp: Math.floor(NOW / 1000) + 300,
    permissions: ["gitlab.access.check"],
    ...claims,
  });
  const data = `${encodedHeader}.${encodedClaims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  return `${data}.${signer.sign(privateKey).toString("base64url")}`;
}

describe("RS256 access token verification", () => {
  it("accepts a valid token and returns the caller identity", () => {
    expect(verifyAccessToken(createToken(), authConfig, NOW)).toEqual({
      subject: "user-123",
      permissions: ["gitlab.access.check"],
    });
  });

  it.each([
    { iss: "https://other.example.test" },
    { aud: "other-service" },
    { sub: "" },
    { exp: Math.floor(NOW / 1000) },
    { nbf: Math.floor(NOW / 1000) + 1 },
    { permissions: ["", "gitlab.access.check"] },
  ])("rejects invalid claims: %j", (claims) => {
    expect(() => verifyAccessToken(createToken(claims), authConfig, NOW)).toThrow(
      AuthenticationError,
    );
  });

  it("accepts an audience array containing the configured audience", () => {
    expect(
      verifyAccessToken(
        createToken({ aud: ["other-service", authConfig.audience] }),
        authConfig,
        NOW,
      ).subject,
    ).toBe("user-123");
  });

  it("rejects an unsupported algorithm, malformed token, and bad signature", () => {
    expect(() =>
      verifyAccessToken(
        createToken({}, { alg: "HS256", typ: "JWT" }),
        authConfig,
        NOW,
      ),
    ).toThrow(AuthenticationError);
    expect(() => verifyAccessToken("a.b.c", authConfig, NOW)).toThrow(
      AuthenticationError,
    );

    const token = createToken();
    const parts = token.split(".");
    parts[1] = encode({ sub: "different-user" });
    expect(() => verifyAccessToken(parts.join("."), authConfig, NOW)).toThrow(
      AuthenticationError,
    );
  });

  it("extracts a Bearer token from the request headers", () => {
    const headers: IncomingHttpHeaders = {
      authorization: `Bearer ${createToken()}`,
    };
    expect(authenticateRequest(headers, authConfig, NOW).subject).toBe("user-123");
  });

  it.each([
    undefined,
    "Basic abc",
    "Bearer invalid",
    "Bearer a.b.c.extra",
  ])("rejects an invalid Authorization header: %s", (authorization) => {
    expect(() =>
      authenticateRequest({ authorization }, authConfig, NOW),
    ).toThrow(AuthenticationError);
  });
});

describe("business permission checks", () => {
  it("allows a caller with the required permission", () => {
    expect(() =>
      requirePermission(
        { subject: "user-123", permissions: ["gitlab.access.check"] },
        "gitlab.access.check",
      ),
    ).not.toThrow();
  });

  it("rejects a caller without the required permission", () => {
    expect(() =>
      requirePermission({ subject: "user-123", permissions: [] }, "job.play"),
    ).toThrow(AuthorizationError);
  });
});
