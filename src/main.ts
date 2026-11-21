#!/usr/bin/env node
/**
 * @file The `sharnessd` executable: it reads the settings file, compiles the
 * server's norms from their documents, opens the server behind the firewall
 * that enforces them on every message, and serves its MCP tools over HTTP to the
 * owners the authentication admits. `--help` prints the
 * usage, no argument serves until the process is stopped, and any other
 * arguments print the usage to standard error. A startup failure prints one
 * line and exits unsuccessfully.
 */
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { discoverAuthorizationServerMetadata } from "@modelcontextprotocol/client";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  Config,
  Console,
  Data,
  Effect,
  Layer,
  Option,
  Order,
  Schema,
  Struct,
} from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { dirname, join, resolve } from "node:path";
import {
  decisionProviderSetting,
  jevDecisionProvider,
} from "./decision-provider.js";
import { makeFirewall } from "./firewall.js";
import { type McpHandler, mcpHandler, packageVersion } from "./mcp.js";
import { AgentName } from "./messages.js";
import { compileNorms } from "./norms/index.js";
import { openServer } from "./server.js";

/**
 * Messages identify the failed operation without disclosing documents or credentials.
 */
class SettingsError extends Data.TaggedError("SettingsError")<{
  readonly message: string;
}> {}

/** A startup failure whose message names the setting to change. */
const settingsError = (message: string) => new SettingsError({ message });

/** The settings file as an operator writes it. */
const settingsFile = Schema.Struct({
  port: Schema.Int.pipe(Schema.between(1, 65535)),
  host: Schema.NonEmptyString,
  authentication: Schema.Struct({
    resource: Schema.URL,
    issuer: Schema.NonEmptyString,
    scope: Schema.NonEmptyString,
  }),
  serverAgent: Schema.Struct({
    name: AgentName,
    subject: Schema.NonEmptyString,
  }),
  normsDirectory: Schema.optional(Schema.NonEmptyString),
  decisionProvider: Schema.optional(decisionProviderSetting),
  historyLimit: Schema.optional(Schema.Int.pipe(Schema.between(1, 1024))),
});

/**
 * The norms of the `.lisp` documents directly in `directory`, compiled in
 * name order, or the failure of a directory that cannot be read, has no
 * such document or has one that does not compile.
 */
const normsIn = Effect.fn("normsIn")(function* (directory: string) {
  const filesystem = yield* FileSystem.FileSystem;
  return yield* filesystem.readDirectory(directory).pipe(
    Effect.flatMap((files) =>
      Effect.forEach(
        files.filter((file) => file.endsWith(".lisp")).sort(Order.string),
        (file) => filesystem.readFileString(join(directory, file)),
        { concurrency: 1 },
      ),
    ),
    Effect.mapError(({ message }) => message),
    Effect.flatMap(compileNorms),
    Effect.mapError((reason) =>
      settingsError(`The norms directory is invalid: ${reason}`),
    ),
  );
});

/**
 * The settings as the process uses them: the settings file, with the norms
 * in place of their directory and the decision provider in place of its
 * setting. The norms directory resolves against the settings
 * file's own directory, whatever the working directory. The provider is Jev
 * under the named model and limits, with the key in the environment
 * variable `SHARNESS_DECISION_PROVIDER_KEY`.
 */
const loadSettings = Effect.fn("loadSettings")(function* () {
  const settingsPath = yield* Config.string("SHARNESS_CONFIG_FILE").pipe(
    Effect.mapError(() =>
      settingsError("Set SHARNESS_CONFIG_FILE to the server settings file"),
    ),
  );
  const filesystem = yield* FileSystem.FileSystem;
  const file = yield* filesystem.readFileString(settingsPath).pipe(
    Effect.flatMap(
      Schema.decodeUnknown(Schema.parseJson(settingsFile), {
        onExcessProperty: "error",
      }),
    ),
    Effect.mapError(() =>
      settingsError("The server settings file is unreadable or invalid"),
    ),
  );
  const settingsDirectory = dirname(resolve(settingsPath));
  const norms =
    file.normsDirectory === undefined
      ? undefined
      : yield* normsIn(resolve(settingsDirectory, file.normsDirectory));
  if (norms?.hasTextRules === true && file.decisionProvider === undefined) {
    return yield* settingsError(
      "The norms describe string or list fields, which need a decisionProvider to judge them",
    );
  }
  const setting = file.decisionProvider;
  const provider =
    setting === undefined
      ? undefined
      : jevDecisionProvider(
          yield* Config.redacted(
            Config.nonEmptyString("SHARNESS_DECISION_PROVIDER_KEY"),
          ).pipe(
            Effect.mapError(() =>
              settingsError(
                "The settings name a decisionProvider: set SHARNESS_DECISION_PROVIDER_KEY to its key",
              ),
            ),
          ),
          setting,
        );
  return {
    ...Struct.omit(file, "normsDirectory", "decisionProvider"),
    norms,
    provider,
  };
});

/**
 * Listens on the settings' host and port as the MCP SDK's example of an
 * OAuth-protected server does: the SDK's Express app validates the Host and
 * Origin headers against the resource's hostname, serves the OAuth discovery
 * documents, and checks each request's bearer token before the MCP handler
 * answers it at `/mcp`. A token is a JWT the issuer signed for the resource
 * with a subject, verified against the key set the issuer's metadata names.
 * Returns once the listener accepts connections.
 */
const listen = Effect.fn("listen")(function* (
  { host, port, authentication }: typeof settingsFile.Type,
  handler: McpHandler,
) {
  const { issuer, resource, scope } = authentication;
  const metadata = yield* Effect.tryPromise(() =>
    discoverAuthorizationServerMetadata(issuer),
  ).pipe(Effect.orElseSucceed(() => undefined));
  if (typeof metadata?.jwks_uri !== "string") {
    return yield* settingsError(
      `The OAuth issuer ${issuer} did not answer with its configuration. Check authentication.issuer and that the server can reach it.`,
    );
  }
  const keys = createRemoteJWKSet(new URL(metadata.jwks_uri));
  const bearerAuth = requireBearerAuth({
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
  });
  const app = createMcpExpressApp({
    host,
    allowedHosts: [resource.hostname],
    allowedOrigins: [resource.hostname],
  });
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: metadata,
      resourceServerUrl: resource,
      scopesSupported: [scope],
    }),
  );
  const node = toNodeHandler(handler);
  app.all("/mcp", bearerAuth, (request, response) =>
    node(request, response, request.body),
  );
  yield* Effect.async<undefined, SettingsError>((resume) => {
    app.listen(port, host, (failed) => {
      resume(
        failed === undefined
          ? Effect.succeed(undefined)
          : settingsError(
              `The server could not listen on ${host}:${port}. Stop the process that uses the port, or set another port.`,
            ),
      );
    });
  });
});

/** What `--help` prints: the variables read at every start. */
const HELP_MESSAGE = [
  "Usage: sharnessd [--help]",
  "",
  "SHARNESS_CONFIG_FILE: JSON server settings file",
  "SHARNESS_DATABASE_URL: PostgreSQL connection URL",
  "SHARNESS_DECISION_PROVIDER_KEY: API key of the decision provider the settings name",
  "Standard OTEL_* variables configure telemetry.",
].join("\n");

/** Printed for a startup failure that names no setting of its own. */
const UNEXPLAINED_FAILURE =
  "The server could not start. Check SHARNESS_CONFIG_FILE and SHARNESS_DATABASE_URL; run sharnessd --help for what each names.";

/** Prints one line to standard error and makes the process exit unsuccessfully. */
const exitUnsuccessfully = (line: string) =>
  Console.error(line).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ),
  );

/**
 * Installs a process-global stderr logger for OpenTelemetry warnings and failures.
 * The logger remains installed after export closes.
 */
const exportDiagnostics = Layer.effectDiscard(
  Effect.sync(() =>
    diag.setLogger(new DiagConsoleLogger(), {
      logLevel: DiagLogLevel.WARN,
      suppressOverrideMessage: true,
    }),
  ),
);

/**
 * Exports spans as OTLP/HTTP protobuf when `OTEL_EXPORTER_OTLP_ENDPOINT` is
 * set, under the service name `OTEL_SERVICE_NAME` gives, or `sharnessd`.
 * OpenTelemetry reads the endpoint and its remaining exporter, batch and
 * resource settings from the standard variables, and warns of one it cannot use.
 */
const spanExport = Layer.unwrapEffect(
  Effect.gen(function* () {
    const endpoint = yield* Config.option(
      Config.nonEmptyString("OTEL_EXPORTER_OTLP_ENDPOINT"),
    );
    if (Option.isNone(endpoint)) {
      return Layer.empty;
    }
    const serviceName = yield* Config.nonEmptyString("OTEL_SERVICE_NAME").pipe(
      Config.withDefault("sharnessd"),
    );
    return NodeSdk.layer(() => ({
      resource: { serviceName, serviceVersion: packageVersion },
      spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
    })).pipe(Layer.discard, Layer.provide(exportDiagnostics));
  }).pipe(Effect.orDie),
);

/** Serves until the process is stopped. Fails if it cannot start. */
const serve = Effect.gen(function* () {
  const url = yield* Config.redacted("SHARNESS_DATABASE_URL").pipe(
    Effect.mapError(() =>
      settingsError(
        "Set SHARNESS_DATABASE_URL to the database the server uses",
      ),
    ),
  );
  const settings = yield* loadSettings();
  const { serverAgent, norms } = settings;
  const server = yield* openServer(
    url,
    serverAgent.name,
    makeFirewall({
      norms,
      provider: settings.provider,
      historyLimit: settings.historyLimit,
    }),
  );
  const handler = yield* mcpHandler(
    server,
    { issuer: settings.authentication.issuer, subject: serverAgent.subject },
    norms,
  );
  yield* listen(settings, handler);
  yield* Console.log(
    `sharnessd listening on http://${settings.host}:${settings.port}/mcp (package ${packageVersion})`,
  );
  return yield* Effect.never;
}).pipe(
  Effect.scoped,
  Effect.withSpan("serve"),
  Effect.provide(Layer.merge(NodeFileSystem.layer, spanExport)),
);

const args = process.argv.slice(2);
NodeRuntime.runMain(
  Effect.suspend(() => {
    if (args.length === 1 && args[0] === "--help") {
      return Console.log(HELP_MESSAGE);
    }
    if (args.length === 0) {
      return serve;
    }
    return exitUnsuccessfully(HELP_MESSAGE);
  }).pipe(
    Effect.catchTag(
      "SettingsError",
      "DatabasePreparationError",
      ({ message }) => exitUnsuccessfully(message),
    ),
    Effect.catchAll(() => exitUnsuccessfully(UNEXPLAINED_FAILURE)),
  ),
);
