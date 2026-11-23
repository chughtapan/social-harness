#!/usr/bin/env node
/**
 * @file The `sharnessd` executable. It reads the settings file, compiles the
 * norms, opens the server with its firewall, and serves the MCP tools over
 * HTTP to authenticated owners.
 *
 * With no arguments it serves until stopped. `--help` prints the usage. Any
 * other arguments print the usage to standard error and exit with status 1.
 * An expected startup failure prints one line and exits with status 1.
 */
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import {
  createMcpExpressApp,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
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
import { dirname, join, resolve } from "node:path";
import { authenticate, authenticationSetting } from "./authentication.js";
import {
  decisionProviderSetting,
  jevDecisionProvider,
} from "./decision-provider.js";
import { makeFirewall } from "./firewall.js";
import { type McpHandler, mcpHandler, packageVersion } from "./mcp.js";
import { AgentName } from "./messages.js";
import { compileNorms } from "./norms/index.js";
import { openServer } from "./server.js";

/** A startup failure. Its message says what to fix and never contains a credential. */
class SettingsError extends Data.TaggedError("SettingsError")<{
  readonly message: string;
}> {}

const settingsError = (message: string) => new SettingsError({ message });

/** The contents of the settings file. */
const settingsFile = Schema.Struct({
  port: Schema.Int.pipe(Schema.between(1, 65535)),
  host: Schema.NonEmptyString,
  authentication: authenticationSetting,
  serverAgent: Schema.Struct({
    name: AgentName,
    subject: Schema.NonEmptyString,
  }),
  normsDirectory: Schema.optional(Schema.NonEmptyString),
  decisionProvider: Schema.optional(decisionProviderSetting),
  historyLimit: Schema.optional(Schema.Int.pipe(Schema.between(1, 1024))),
});

/**
 * Compiles the `.lisp` files in `directory`, in file name order.
 * Subdirectories are not read. Fails if the directory cannot be read, holds
 * no `.lisp` file, holds one that does not compile, or holds two with the
 * same norm name.
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
 * Reads the settings file and returns the settings with the norms compiled
 * and the decision provider built.
 *
 * `normsDirectory` is resolved relative to the settings file, not the
 * working directory. The provider's key comes from the environment variable
 * `SHARNESS_DECISION_PROVIDER_KEY`.
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

/** Serves MCP behind the configured verifier and publishes issuer metadata when available. */
const listen = Effect.fn("listen")(function* (
  { host, port }: typeof settingsFile.Type,
  {
    resource,
    bearerAuth,
    metadataRouter,
  }: Effect.Effect.Success<ReturnType<typeof authenticate>>,
  handler: McpHandler,
) {
  const app = createMcpExpressApp({
    host,
    allowedHosts: [resource.hostname],
    allowedOrigins: [resource.hostname],
  });
  if (metadataRouter !== undefined) {
    app.use(metadataRouter);
  }
  const node = toNodeHandler(handler);
  app.all("/mcp", requireBearerAuth(bearerAuth), (request, response) =>
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

/** The usage text, which lists the environment variables the server reads. */
const HELP_MESSAGE = [
  "Usage: sharnessd [--help]",
  "",
  "SHARNESS_CONFIG_FILE: JSON server settings file",
  "SHARNESS_DATABASE_URL: PostgreSQL connection URL",
  "SHARNESS_DECISION_PROVIDER_KEY: API key of the decision provider the settings name",
  "Standard OTEL_* variables configure telemetry.",
].join("\n");

/** Printed when startup fails for a reason that has no message of its own. */
const UNEXPLAINED_FAILURE =
  "The server could not start. Check SHARNESS_CONFIG_FILE and SHARNESS_DATABASE_URL; run sharnessd --help for what each names.";

/** Prints `line` to standard error and sets the exit status to 1. */
const exitUnsuccessfully = (line: string) =>
  Console.error(line).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ),
  );

/**
 * Sends OpenTelemetry's own warnings and errors to standard error. The
 * logger is global to the process and stays installed after export stops.
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
 * Exports spans over OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set,
 * and does nothing otherwise. The service name is `OTEL_SERVICE_NAME`, or
 * `sharnessd` if that is unset. OpenTelemetry reads its other settings from
 * the standard `OTEL_*` variables.
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

/** Starts the server and runs until the process is stopped. Fails if startup fails. */
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
  const authentication = yield* authenticate(
    settings.authentication,
    settings.host,
    settings.port,
    serverAgent.subject,
  ).pipe(Effect.mapError(settingsError));
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
    { issuer: authentication.issuer, subject: serverAgent.subject },
    norms,
  );
  yield* listen(settings, authentication, handler);
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
