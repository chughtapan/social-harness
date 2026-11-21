/**
 * @file The MCP tools and inbox event through which an agent's host reaches
 * the server: the tools of the caller's role, each call's result or failure,
 * and the event whose occurrences are the caller's inbox entries.
 */

import {
  type AuthInfo,
  McpServer,
  type McpServerFactory,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { EventsExtension } from "@modelcontextprotocol/server/ext/events";
import { nodeWebhookSender } from "@modelcontextprotocol/server/ext/events/node";
import { Effect, JSONSchema, Runtime, Schema } from "effect";
import { createHash } from "node:crypto";
import packageJson from "../package.json" with { type: "json" };
import { checkRecordSchema } from "./firewall.js";
import { AgentName, MsgId, wellFormedString } from "./messages.js";
import { ACT_SYNTAX, type Norms, publishedNorm } from "./norms/index.js";
import {
  ConversationPage,
  Cursor,
  Entry,
  type Failure,
  InboxPage,
  PAGE_SIZE,
  SendReceipt,
  type Server,
} from "./server.js";

/** The version of this package, as MCP clients and telemetry read it. */
export const packageVersion: string = packageJson.version;

/** The cursor a read takes: the `nextCursor` an earlier result gave. */
const cursorArgument = Schema.optional(Cursor).annotations({
  description: "the nextCursor of an earlier result",
});

const noArguments = Schema.Record({
  key: Schema.String,
  value: Schema.Never,
}).annotations({
  jsonSchema: { type: "object", properties: {}, additionalProperties: false },
});

const sentFields = {
  text: Schema.propertySignature(wellFormedString).annotations({
    description: "The message text.",
  }),
  replyToMsgId: Schema.optional(MsgId).annotations({
    description:
      "The message id of the message this replies to. Omit it when opening a new instance of a norm.",
  }),
};

/**
 * The longest a receive_messages call may wait. It stays under the time after
 * which hosts and proxies give up on a tool call.
 */
const MAXIMUM_WAIT_SECONDS = 50;

/** How often the SDK reads the inbox of an agent whose host has a push stream or a webhook subscription. */
const INBOX_CHECK_MILLISECONDS = 1000;

const WEBHOOK_TTL_MILLISECONDS = 30 * 60_000;

const INBOX_EVENT = "org.social-harness/inbox.pending";

/**
 * The factory the MCP SDK builds each request's server with, over an open
 * `server`. A request's `authInfo` names its owner in `extra.issuer` and
 * `extra.subject`: the owner `admits.issuer` and `admits.subject` name has
 * the server agent, and every other owner has a client, named from its
 * issuer and subject. `norms` are the norms the server publishes, whose
 * documents every agent reads with `read_norms`. A tool call runs on the
 * runtime this effect ran in and is interrupted when its request is aborted.
 */
export const mcpServerFactory = Effect.fn("serverFactory")(function* (
  server: Server,
  admits: {
    readonly issuer: string;
    readonly subject: string;
  },
  norms?: Norms,
) {
  const run = Runtime.runPromise(yield* Effect.runtime());

  /** The agent an admitted request's token names. */
  const callerOf = (authInfo?: AuthInfo) => {
    const issuer = String(authInfo?.extra?.issuer);
    const subject = String(authInfo?.extra?.subject);
    return issuer === admits.issuer && subject === admits.subject
      ? server.name
      : AgentName.make(
          `agent-${createHash("sha256")
            .update(`${issuer}\0${subject}`)
            .digest("hex")
            .slice(0, 24)}`,
        );
  };

  /**
   * The inbox event: an occurrence is an inbox entry, and a subscription's
   * cursor is an inbox cursor. The SDK delivers by poll, push and webhook,
   * and keeps every subscription in memory.
   */
  const events = new EventsExtension({
    getPrincipal: ({ http }) => callerOf(http?.authInfo),
    checkIntervalMs: INBOX_CHECK_MILLISECONDS,
    webhookTtlMs: WEBHOOK_TTL_MILLISECONDS,
    webhookSender: nodeWebhookSender(),
  });
  events.registerEvent(INBOX_EVENT, {
    description: "An inbox entry: its message.",
    payloadSchema: standard(Entry),
    check: (...[{ principal, maxEvents, signal }, , cursor]) =>
      run(inboxOccurrences(server, principal, { cursor, maxEvents }), {
        signal,
      }),
  });

  const factory: McpServerFactory = ({ authInfo }) => {
    const caller = callerOf(authInfo);
    const mcp = new McpServer(
      { name: "sharnessd", version: packageVersion },
      { extensions: [events] },
    );
    const at = { mcp, server, run };
    registerSharedTools(at, caller, norms);
    if (caller === server.name) {
      registerServerAgentTools(at);
    } else {
      registerClientTools(at, caller);
    }
    return mcp;
  };
  return factory;
});

/** What a request's tools are registered with: the SDK server of the request, the server whose operations they run, and the runner of their calls. */
interface Registration {
  readonly mcp: McpServer;
  readonly server: Server;
  readonly run: ReturnType<typeof Runtime.runPromise<never>>;
}

/** One check of the inbox event for the agent `principal` names. */
function inboxOccurrences(
  server: Server,
  principal: string | null,
  after: { readonly cursor: string | null; readonly maxEvents?: number },
) {
  return Effect.gen(function* () {
    const page = yield* server.inbox(
      yield* Schema.decodeUnknown(AgentName)(principal),
      {
        limit: Math.min(after.maxEvents ?? PAGE_SIZE, PAGE_SIZE),
        ...(after.cursor === null
          ? {}
          : { cursor: yield* Schema.decode(Cursor)(after.cursor) }),
      },
    );
    return {
      events: (yield* Schema.encode(Schema.Array(Entry))(page.entries)).map(
        (data) => ({
          eventId: `${data.message.author}/${data.message.msgId}`,
          data,
        }),
      ),
      cursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  });
}

function registerSharedTools(
  at: Registration,
  caller: AgentName,
  norms?: Norms,
) {
  const { server } = at;
  register(
    at,
    "status",
    {
      description:
        "Read this agent's name, which is the author of the messages it sends.",
      input: noArguments,
      output: Schema.Struct({ agentName: AgentName }),
      readOnly: true,
    },
    () => Effect.succeed({ agentName: caller }),
  );
  register(
    at,
    "receive_messages",
    {
      description:
        "Receive inbox entries in order, each with its message. Keep the nextCursor of every result and pass it as cursor on the next call to receive the entries after it. Without cursor the call starts from now: it returns no earlier entries. hasMore says more entries follow the page now. Pass wait to wait up to that many seconds when no entry follows the cursor; the call returns as soon as one becomes readable, or with no entries when the wait ends.",
      input: Schema.Struct({
        cursor: cursorArgument,
        wait: Schema.optional(
          Schema.Number.pipe(
            Schema.positive(),
            Schema.lessThanOrEqualTo(MAXIMUM_WAIT_SECONDS),
          ).annotations({
            description: `a number of seconds, at most ${String(MAXIMUM_WAIT_SECONDS)}, to wait for an entry when none follows the cursor. Call receive_messages again with nextCursor to keep waiting. Without wait the call returns at once.`,
          }),
        ),
      }),
      output: InboxPage,
      readOnly: true,
    },
    (request) => server.receive(caller, request),
  );
  if (norms !== undefined) {
    register(
      at,
      "read_norms",
      {
        description: `${
          caller === server.name
            ? "List the norms this server publishes, each with its complete document: which of client and server sends each act, when, and what each field contains. You are the server, and your messages and your clients' must follow the same norms."
            : "List the norms the server publishes, each with its complete document: which of client and server sends each act, when, and what each field contains. You are the client, and only a message that follows them is sent."
        } ${ACT_SYNTAX}`,
        input: noArguments,
        output: Schema.Struct({ norms: Schema.Array(publishedNorm) }),
        readOnly: true,
      },
      () => Effect.succeed({ norms: norms.published }),
    );
  }
}

/** The server agent names the client of each conversation and reads its firewall's decisions. */
function registerServerAgentTools(at: Registration) {
  const { server } = at;
  register(
    at,
    "send_message",
    {
      description:
        "Send a message to a client. You can write only to a client that has written to you: any other name fails with unknown-agent. Returns id, the message id. A refused message was not sent: its error gives the feedback of the rules it broke and names the check. Use receive_messages to read what clients send.",
      input: Schema.Struct({
        to: Schema.propertySignature(AgentName).annotations({
          description:
            "The client's name: the author of a message you received.",
        }),
        ...sentFields,
      }),
      output: SendReceipt,
    },
    ({ to, ...sent }) => server.send(server.name, to, sent),
  );
  register(
    at,
    "read_conversation",
    {
      description:
        "Read your conversation with one client: the messages you sent and those you received. Each page gives the oldest entries after cursor, each with its message; pass nextCursor as cursor, with the same client, until it is absent.",
      input: Schema.Struct({
        with: Schema.propertySignature(AgentName).annotations({
          description: "The client's name.",
        }),
        cursor: cursorArgument,
      }),
      output: ConversationPage,
      readOnly: true,
    },
    (input) => server.conversationWith(input.with, input.cursor),
  );
  register(
    at,
    "list_conversations",
    {
      description:
        "List the name of every client that has written to you. Use read_conversation to read one client's conversation.",
      input: noArguments,
      output: Schema.Struct({ clients: Schema.Array(AgentName) }),
      readOnly: true,
    },
    () => Effect.map(server.clients, (clients) => ({ clients })),
  );
  register(
    at,
    "read_firewall_decisions",
    {
      description:
        "Read the records of the hundred latest completed firewall checks since inclusive Unix milliseconds, newest first. Each gives which member sent the message (client or server), the client of its conversation, the decision (allowed or refused) and, for a refused message, the reason and the rules that refused it with their feedback, without message content or private model evidence.",
      input: Schema.Struct({ since: Schema.optional(Schema.NonNegativeInt) }),
      output: Schema.Struct({ decisions: Schema.Array(checkRecordSchema) }),
      readOnly: true,
    },
    ({ since }) =>
      Effect.map(server.decisions(since ?? 0), (decisions) => ({
        decisions,
      })),
  );
}

/** A client names no recipient and no conversation: both are the server agent. */
function registerClientTools(at: Registration, client: AgentName) {
  const { server } = at;
  register(
    at,
    "send_message",
    {
      description:
        "Send a message to the server agent. Returns id, the message id. A refused message was not sent: its error gives the feedback of the rules it broke, or says the server is unavailable, when the same message may be sent again later. Read the reply with receive_messages.",
      input: Schema.Struct(sentFields),
      output: SendReceipt,
    },
    (sent) => server.send(client, client, sent),
  );
  register(
    at,
    "read_conversation",
    {
      description:
        "Read your conversation with the server agent: the messages you sent and those you received. Each page gives the oldest entries after cursor, each with its message; pass nextCursor as cursor until it is absent.",
      input: Schema.Struct({ cursor: cursorArgument }),
      output: ConversationPage,
      readOnly: true,
    },
    ({ cursor }) => server.conversation(client, cursor),
  );
}

/**
 * Registers a tool whose calls `execute` answers. A call runs with `run` and
 * is interrupted when its request is aborted. Its value is the result's structured content. A typed failure is a result
 * marked as an error. A call that ends any other way is logged and answered
 * with a fixed text that says nothing of what went wrong.
 */
function register<A, I, B extends object, J extends object, E extends Failure>(
  { mcp, run }: Registration,
  name: string,
  tool: {
    readonly description: string;
    readonly input: Schema.Schema<A, I>;
    readonly output: Schema.Schema<B, J>;
    readonly readOnly?: true;
  },
  execute: (input: A) => Effect.Effect<B, E>,
) {
  const outputSchema: StandardSchemaWithJSON<object, object> = standard(
    tool.output,
  );
  mcp.registerTool(
    name,
    {
      description: tool.description,
      inputSchema: standard(tool.input),
      outputSchema,
      annotations: tool.readOnly && {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    (input, ctx) =>
      run(
        execute(input).pipe(
          Effect.flatMap((value) =>
            Effect.orDie(Schema.encode(tool.output)(value)),
          ),
          Effect.map((structuredContent) => ({ structuredContent })),
          Effect.catchAll((failure) => Effect.succeed(failed(failure))),
          Effect.catchAllDefect((defect) =>
            Effect.logError("A tool call ended unexpectedly", defect).pipe(
              Effect.as({
                isError: true as const,
                content: [
                  {
                    type: "text" as const,
                    text: "The server could not complete this call. Try again; if it keeps failing, check the server's log.",
                  },
                ],
              }),
            ),
          ),
        ),
        { signal: ctx.mcpReq.signal },
      ),
  );
}

function failed(failure: Failure) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: failure.message }],
    structuredContent: Object.fromEntries(
      Object.entries(failure).filter(
        ([field, value]) => field !== "_tag" && value !== undefined,
      ),
    ),
  };
}

/**
 * `schema` as the Standard Schema the MCP SDK validates a value with and
 * lists as JSON Schema. Effect's own Standard Schema carries no JSON Schema,
 * which the SDK requires. A value with a field the schema does not name is
 * invalid.
 */
function standard<A, I>(
  schema: Schema.Schema<A, I>,
): StandardSchemaWithJSON<I, A> {
  const definitions: Record<string, JSONSchema.JsonSchema7> = {};
  const root = JSONSchema.fromAST(schema.ast, {
    definitions,
    target: "jsonSchema2020-12",
    topLevelReferenceStrategy: "skip",
  });
  const json = () => ({
    ...root,
    ...(Object.keys(definitions).length === 0 ? {} : { $defs: definitions }),
  });
  return {
    "~standard": {
      ...Schema.standardSchemaV1(schema, { onExcessProperty: "error" })[
        "~standard"
      ],
      jsonSchema: { input: json, output: json },
    },
  };
}
