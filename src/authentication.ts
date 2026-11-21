/**
 * @file How `sharnessd` admits a request as an owner: by an OAuth access
 * token its issuer signed, or, in development, by the name the request gives
 * itself.
 */

import { discoverAuthorizationServerMetadata } from "@modelcontextprotocol/client";
import {
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  localhostAllowedOrigins,
  OAuthError,
  OAuthErrorCode,
  oauthMetadataResponse,
  originValidationResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { Data, Effect, Schema } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * The URL `value` names when it parses, uses one of `protocols` (each with its
 * colon) and carries no userinfo and no fragment; otherwise `undefined`.
 */
const plainUrl = (
  value: string | URL,
  protocols: readonly string[],
): URL | undefined => {
  if (!URL.canParse(value)) {
    return undefined;
  }
  const url = new URL(value);
  return protocols.includes(url.protocol) &&
    [url.username, url.password, url.hash].every((part) => part === "")
    ? url
    : undefined;
};

const httpsUrl = Schema.String.pipe(
  Schema.filter((value) => plainUrl(value, ["https:"])?.search === ""),
);

/** Plaintext discovery is limited to local issuer fixtures; hosted providers require HTTPS. */
const oauthIssuer = Schema.Union(
  httpsUrl,
  Schema.String.pipe(
    Schema.filter((value) => {
      const url = plainUrl(value, ["http:"]);
      return url?.search === "" && url.hostname === "127.0.0.1";
    }),
  ),
);

/** The OAuth resource the server is, and the issuer whose tokens it admits. */
const oauth = Schema.Struct({
  resource: httpsUrl.pipe(
    Schema.filter(
      (value) =>
        new URL(value).pathname === "/mcp" && new URL(value).href === value,
    ),
    Schema.compose(Schema.URL),
  ),
  issuer: oauthIssuer,
  scope: Schema.String.pipe(Schema.pattern(/^[\x21\x23-\x5B\x5D-\x7E]+$/u)),
});

/**
 * The `authentication` setting: the OAuth resource and issuer, or
 * `"development"`, which verifies nothing.
 */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- main.ts composes this setting into the settings file's schema.
export const authentication = Schema.Union(
  Schema.Literal("development"),
  oauth,
);

/** The OAuth issuer did not give the configuration tokens are verified with. */
class IssuerError extends Data.TaggedError("IssuerError")<{
  readonly issuer: string;
}> {
  override get message(): string {
    return `The OAuth issuer ${this.issuer} did not answer with its configuration. Check authentication.issuer and that the server can reach it.`;
  }
}

/** How the listener admits requests. */
export interface Admission {
  /** The issuer every admitted owner is named under. */
  readonly issuer: string;
  /** Answers a request that reaches no tool: one whose Host or Origin is not allowed, or one for an OAuth discovery document. */
  readonly answer: (request: Request) => Response | undefined;
  /** The owner a request's bearer token names, or the refusal of the request. */
  readonly owner: ReturnType<typeof requireBearerAuth>;
}

/** The issuer every owner is named under when nothing is verified. */
const DEVELOPMENT_ISSUER = "development";

/** The SDK admits only a token that expires, so each request's token is given an hour from its arrival. */
const DEVELOPMENT_TOKEN_SECONDS = 3600;

/**
 * Admits each request as the owner its bearer token names, without verifying
 * anything: whoever reaches the listener acts as any agent. A request from a
 * web page is refused unless the page is on this machine, so a site the
 * operator visits cannot act through their browser.
 */
const development: Admission = {
  issuer: DEVELOPMENT_ISSUER,
  answer: (request) =>
    originValidationResponse(request, localhostAllowedOrigins()),
  owner: requireBearerAuth({
    verifier: {
      verifyAccessToken: (token) =>
        Promise.resolve({
          token,
          clientId: "",
          scopes: [],
          expiresAt: Date.now() / 1000 + DEVELOPMENT_TOKEN_SECONDS,
          extra: { issuer: DEVELOPMENT_ISSUER, subject: token },
        }),
    },
  }),
};

/**
 * How requests are admitted under `setting`. With OAuth the listener answers
 * as the MCP SDK's example of a bearer-authenticated server does: the SDK
 * validates the Host and Origin headers against the resource's hostname,
 * serves the OAuth discovery documents, and checks the bearer token's scope
 * and expiry; a refusal is the SDK's response. A token is a JWT the issuer
 * signed for the resource with a subject, verified against the key set the
 * issuer's metadata names.
 */
export const admission = Effect.fn("admission")(function* (
  setting: typeof authentication.Type,
) {
  if (setting === "development") {
    return development;
  }
  const { issuer, resource, scope } = setting;
  const metadata = yield* Effect.tryPromise({
    try: () => discoverAuthorizationServerMetadata(issuer),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (typeof metadata?.jwks_uri !== "string") {
    return yield* new IssuerError({ issuer });
  }
  const keys = createRemoteJWKSet(new URL(metadata.jwks_uri));
  const hostnames = [resource.hostname];
  const discovery = {
    oauthMetadata: metadata,
    resourceServerUrl: resource,
    scopesSupported: [scope],
  };
  const verified: Admission = {
    issuer,
    answer: (request) =>
      hostHeaderValidationResponse(request, hostnames) ??
      originValidationResponse(request, hostnames) ??
      oauthMetadataResponse(request, discovery),
    owner: requireBearerAuth({
      requiredScopes: [scope],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
      verifier: {
        // eslint-disable-next-line agent-code-guard/async-keyword -- The MCP SDK's authorization API is promise-based.
        verifyAccessToken: async (token) => {
          const signed = await jwtVerify(token, keys, {
            issuer,
            audience: resource.href,
            algorithms: ["RS256"],
          }).catch(() => undefined);
          if (!signed?.payload.sub) {
            throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid token");
          }
          const { sub, scope: granted, exp } = signed.payload;
          return {
            token,
            clientId: "",
            scopes: typeof granted === "string" ? granted.split(" ") : [],
            expiresAt: exp,
            extra: { issuer, subject: sub },
          };
        },
      },
    }),
  };
  return verified;
});
