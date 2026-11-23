/** @file HTTP authentication for owners identified by a local token or an OAuth issuer. */
import { discoverAuthorizationServerMetadata } from "@modelcontextprotocol/client";
import {
  type BearerAuthMiddlewareOptions,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/express";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { Clock, Config, Effect, Redacted, Schema } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";

const localAuthentication = Schema.Struct({
  mode: Schema.Literal("local"),
  tokenEnvBySubject: Schema.Record({
    key: Schema.NonEmptyString,
    value: Schema.NonEmptyString,
  }),
});

/** Selects the verifier for every request made to the daemon. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The daemon embeds the authentication grammar in its settings.
export const authenticationSetting = Schema.Union(
  localAuthentication,
  Schema.Struct({
    issuer: Schema.NonEmptyString,
    resource: Schema.URL,
    scope: Schema.NonEmptyString,
  }),
);

const localTokenLifetimeSeconds = 3600;
/** Loads the credentials once, binding them to this listener and a single expiry. */
const localVerifier = Effect.fn("localVerifier")(function* (
  host: string,
  port: number,
  tokenEnvBySubject: typeof localAuthentication.Type.tokenEnvBySubject,
  serverSubject: string,
) {
  if (host !== "127.0.0.1" && host !== "::1") {
    return yield* Effect.fail(
      "Local authentication requires a loopback host: 127.0.0.1 or ::1",
    );
  }
  if (!Object.hasOwn(tokenEnvBySubject, serverSubject)) {
    return yield* Effect.fail(
      "Add the server agent subject to authentication.tokenEnvBySubject",
    );
  }
  const resource = new URL(
    `http://${host === "::1" ? "[::1]" : host}:${port}/mcp`,
  );
  const issuer = "urn:social-harness:local";
  const expiresAt =
    Math.floor((yield* Clock.currentTimeMillis) / 1000) +
    localTokenLifetimeSeconds;
  const subjects = new Map<string, string>();
  for (const [subject, variable] of Object.entries(tokenEnvBySubject)) {
    const secret = yield* Config.redacted(Config.nonEmptyString(variable)).pipe(
      Effect.mapError(
        () => `Set ${variable} to the local bearer token for ${subject}`,
      ),
    );
    const token = Redacted.value(secret);
    if (subjects.has(token)) {
      return yield* Effect.fail(
        `Give ${subject} a distinct local bearer token in ${variable}`,
      );
    }
    subjects.set(token, subject);
  }
  const verifier: OAuthTokenVerifier = {
    verifyAccessToken: (token) => {
      const subject = subjects.get(token);
      return subject === undefined
        ? Promise.reject(
            new OAuthError(OAuthErrorCode.InvalidToken, "Invalid token"),
          )
        : Promise.resolve({
            token,
            clientId: subject,
            scopes: [],
            resource,
            expiresAt,
            extra: { issuer, subject },
          });
    },
  };
  return { issuer, resource, verifier };
});

/** Loads issuer metadata and verifies signed access tokens for its resource. */
const oauthAuthentication = Effect.fn("oauthAuthentication")(function* ({
  issuer,
  resource,
  scope,
}: Extract<typeof authenticationSetting.Type, { issuer: string }>) {
  const metadata = yield* Effect.tryPromise(() =>
    discoverAuthorizationServerMetadata(issuer),
  ).pipe(Effect.orElseSucceed(() => undefined));
  if (typeof metadata?.jwks_uri !== "string") {
    return yield* Effect.fail(
      `The OAuth issuer ${issuer} did not answer with its configuration. Check authentication.issuer and that the server can reach it.`,
    );
  }
  const keys = createRemoteJWKSet(new URL(metadata.jwks_uri));
  const bearerAuth: BearerAuthMiddlewareOptions = {
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
  };
  const metadataRouter = mcpAuthMetadataRouter({
    oauthMetadata: metadata,
    resourceServerUrl: resource,
    scopesSupported: [scope],
  });
  return { issuer, resource, bearerAuth, metadataRouter };
});

/** Supplies the MCP bearer check and the issuer used to derive agent identities. */
export const authenticate = Effect.fn("authenticate")(function* (
  authentication: typeof authenticationSetting.Type,
  host: string,
  port: number,
  serverSubject: string,
) {
  if ("mode" in authentication) {
    const { issuer, resource, verifier } = yield* localVerifier(
      host,
      port,
      authentication.tokenEnvBySubject,
      serverSubject,
    );
    const bearerAuth: BearerAuthMiddlewareOptions = {
      expectedResource: resource,
      verifier,
    };
    return { issuer, resource, bearerAuth, metadataRouter: undefined };
  }
  return yield* oauthAuthentication(authentication);
});
