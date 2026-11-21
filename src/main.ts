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
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The MCP SDK's Node handler serves on a node:http server.
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { type Admission, admission, authentication } from "./authentication.js";
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
  authentication,
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
 * Listens on the settings' host and port. A request the admission answers
 * gets that answer, any path but `/mcp` answers 404, and every other request
 * reaches the MCP handler as the owner it is admitted as. Returns once the
 * listener accepts connections.
 */
const listen = Effect.fn("listen")(function* (
  { host, port }: typeof settingsFile.Type,
  admitted: Admission,
  handler: McpHandler,
) {
  // eslint-disable-next-line agent-code-guard/async-keyword -- The MCP SDK's Node handler takes a promise-based fetch function.
  const fetch = async (request: Request) => {
    const answered = admitted.answer(request);
    if (answered !== undefined) {
      return answered;
    }
    if (new URL(request.url).pathname !== "/mcp") {
      return new Response(null, { status: 404 });
    }
    const authInfo = await admitted.owner(request);
    return authInfo instanceof Response
      ? authInfo
      : await handler.fetch(request, { authInfo });
  };
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- The MCP SDK's Node handler is a request listener that returns a promise it never rejects.
  const listener = createServer(toNodeHandler({ fetch }));
  yield* Effect.async<undefined, SettingsError>((resume) => {
    listener.once("error", () => {
      resume(
        settingsError(
          `The server could not listen on ${host}:${port}. Stop the process that uses the port, or set another port.`,
        ),
      );
    });
    listener.listen(port, host, () => {
      resume(Effect.succeed(undefined));
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

/** Printed at every start that verifies no caller. */
const DEVELOPMENT_WARNING =
  'sharnessd verifies no caller: authentication is "development", so whoever reaches this port acts as the owner its bearer token names. Do not expose it.';

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
  const admitted = yield* admission(settings.authentication);
  if (settings.authentication === "development") {
    yield* Console.error(DEVELOPMENT_WARNING);
  }
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
    { issuer: admitted.issuer, subject: serverAgent.subject },
    norms,
  );
  yield* listen(settings, admitted, handler);
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
      "IssuerError",
      "DatabasePreparationError",
      ({ message }) => exitUnsuccessfully(message),
    ),
    Effect.catchAll(() => exitUnsuccessfully(UNEXPLAINED_FAILURE)),
  ),
);
