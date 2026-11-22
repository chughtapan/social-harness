/**
 * @file The MCP interface. It registers the tools for the caller's role,
 * turns each operation's result or failure into a tool result, and publishes
 * new inbox entries as an MCP event.
 */

import {
  type AuthInfo,
  createMcpHandler,
  McpServer,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { EventsExtension } from "@modelcontextprotocol/server/ext/events";
import { nodeWebhookSender } from "@modelcontextprotocol/server/ext/events/node";
import { Effect, JSONSchema, Runtime, Schema } from "effect";
import { createHash } from "node:crypto";
import packageJson from "../package.json" with { type: "json" };
import { checkRecordSchema } from "./firewall.js";
import { AgentName, Message, MsgId, wellFormedString } from "./messages.js";
import { ACT_SYNTAX, normDocument, type Norms } from "./norms/index.js";
import { type Failure, PAGE_SIZE, type Server } from "./server.js";

/** This package's version, reported to MCP clients and in telemetry. */
export const packageVersion: string = packageJson.version;

/** A cursor. A host, the program that connects an agent to this server, sees it as decimal text. Decoding it gives the place the server reads from. */
const Cursor = Schema.compose(
  Schema.String.pipe(Schema.pattern(/^\d{1,15}$/u)),
  Schema.NumberFromString,
);

/** One item of an inbox or conversation page: a message. */
const Entry = Schema.Struct({ message: Message });

const pageOfEntries = Schema.Array(Entry).pipe(Schema.maxItems(PAGE_SIZE));

/** The result of an inbox read. `nextCursor` is always present. `hasMore` is true when more entries are already waiting. */
const InboxPage = Schema.Struct({
  entries: pageOfEntries,
  nextCursor: Cursor,
  hasMore: Schema.Boolean,
});

/** The result of a conversation read. `nextCursor` is present only when there is another page. */
const ConversationPage = Schema.Struct({
  entries: pageOfEntries,
  nextCursor: Schema.optional(Cursor),
});

/** The result of a send: the id of the stored message. */
const SendReceipt = Schema.Struct({ msgId: MsgId });

/** Converts a server page to an inbox result. */
const inboxPage = (page: Page) => ({
  entries: page.messages.map((message) => ({ message })),
  nextCursor: page.next,
  hasMore: page.more,
});

/** Converts a server page to a conversation result. */
const conversationPage = (page: Page) => ({
  entries: page.messages.map((message) => ({ message })),
  ...(page.more ? { nextCursor: page.next } : {}),
});

/** The optional `cursor` argument of the read tools. */
const cursorArgument = Schema.optional(Cursor).annotations({
  description: "the nextCursor of an earlier result",
});

/** The input of a tool that takes no arguments. Its JSON Schema is given explicitly as an object with no properties. */
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
      "The message id of the message this replies to. Omit it on the act that starts an instance of a norm.",
  }),
};

/**
 * The longest a `receive_messages` call may wait. Hosts and proxies commonly
 * give up on a tool call after about a minute, so this stays below that.
 */
const MAXIMUM_WAIT_SECONDS = 50;

/** How often the SDK checks the inbox for a host subscribed by push or webhook. */
const INBOX_CHECK_MILLISECONDS = 1000;

/** The lifetime the SDK gives a webhook subscription. */
const WEBHOOK_TTL_MILLISECONDS = 30 * 60_000;

/** The name of the MCP event for new inbox entries. */
const INBOX_EVENT = "org.social-harness/inbox.pending";

/**
 * Makes the MCP handler for an open server. Each request gets the tools of
 * the agent it is authenticated as.
 *
 * A request's `authInfo.extra` carries its owner's `issuer` and `subject`.
 * The owner matching `admits` is the server agent. Every other owner is a
 * client, whose name is derived from its issuer and subject.
 *
 * `norms` are the server's norms, which `read_norms` returns. A tool call is
 * interrupted when its request is aborted.
 */
export const mcpHandler = Effect.fn("mcpHandler")(function* (
  server: Server,
  admits: {
    readonly issuer: string;
    readonly subject: string;
  },
  norms?: Norms,
) {
  const run = Runtime.runPromise(yield* Effect.runtime());

  /** The name of the agent a request is authenticated as. */
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
   * The inbox event. Each new inbox entry is one occurrence, and an event
   * cursor is an inbox cursor. The SDK handles poll, push and webhook
   * delivery and keeps subscriptions in memory, so they end with the process.
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

  return createMcpHandler(({ authInfo }) => {
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
  });
});

/** The handler that answers MCP requests. */
export type McpHandler = Effect.Effect.Success<ReturnType<typeof mcpHandler>>;

/** A page as the server returns it. */
type Page = Effect.Effect.Success<ReturnType<Server["conversation"]>>;

/** What registering a tool needs: the request's MCP server object, the server whose operations the tool calls, and the function that runs an effect. */
interface Registration {
  readonly mcp: McpServer;
  readonly server: Server;
  readonly run: ReturnType<typeof Runtime.runPromise<never>>;
}

/** Reads new inbox entries for the agent named `principal`, in the form the Events extension expects. */
function inboxOccurrences(
  server: Server,
  principal: string | null,
  after: { readonly cursor: string | null; readonly maxEvents?: number },
) {
  return Effect.gen(function* () {
    const page = yield* Effect.flatMap(
      server.inbox(yield* Schema.decodeUnknown(AgentName)(principal), {
        limit: Math.min(after.maxEvents ?? PAGE_SIZE, PAGE_SIZE),
        ...(after.cursor === null
          ? {}
          : { after: yield* Schema.decode(Cursor)(after.cursor) }),
      }),
      (read) => Schema.encode(InboxPage)(inboxPage(read)),
    );
    return {
      events: page.entries.map((data) => ({
        eventId: `${data.message.author}/${data.message.msgId}`,
        data,
      })),
      cursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  });
}

/** Registers the tools both roles have. `read_norms` is registered only when the server has norms. */
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
    ({ cursor, wait }) =>
      Effect.map(server.receive(caller, { after: cursor, wait }), inboxPage),
  );
  if (norms !== undefined) {
    register(
      at,
      "read_norms",
      {
        description: `${
          caller === server.name
            ? "List the norms this server publishes, each with its complete document: which of client and server sends each act, when, and what each field contains. The norms call you server: your messages and your clients' must follow the same norms."
            : "List the norms the server publishes, each with its complete document: which of client and server sends each act, when, and what each field contains. The norms call you client: only a message that follows them is sent."
        } ${ACT_SYNTAX}`,
        input: noArguments,
        output: Schema.Struct({ norms: Schema.Array(normDocument) }),
        readOnly: true,
      },
      () => Effect.succeed({ norms: norms.documents }),
    );
  }
}

/** Registers the server agent's tools. Its send and read tools take a client name, and it alone can list conversations and read firewall decisions. */
function registerServerAgentTools(at: Registration) {
  const { server } = at;
  register(
    at,
    "send_message",
    {
      description:
        "Send a message to a client. You can write only to a client that has written to you: any other name fails with unknown-client. Returns msgId, the message's id, which a reply to it gives as replyToMsgId. A refused message was not sent: its error gives the feedback of the rules it broke and names the check. Use receive_messages to read what clients send.",
      input: Schema.Struct({
        to: Schema.propertySignature(AgentName).annotations({
          description:
            "The client's name: the author of a message you received.",
        }),
        ...sentFields,
      }),
      output: SendReceipt,
    },
    ({ to, ...sent }) => server.send("server", to, sent),
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
    (input) =>
      Effect.map(
        server.conversationWith(input.with, input.cursor ?? 0),
        conversationPage,
      ),
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
        "Read the records of the hundred latest completed firewall checks since inclusive Unix milliseconds, newest first. Each gives which member sent the message (client or server), the client of its conversation, the decision (allowed or refused) and, for a refused message, the reason and the rules that refused it with their feedback, without message content or the decision provider's answers.",
      input: Schema.Struct({ since: Schema.optional(Schema.NonNegativeInt) }),
      output: Schema.Struct({ decisions: Schema.Array(checkRecordSchema) }),
      readOnly: true,
    },
    ({ since }) =>
      Effect.map(server.records(since ?? 0), (decisions) => ({
        decisions,
      })),
  );
}

/** Registers a client's tools. They take no recipient, because a client talks only to the server agent. */
function registerClientTools(at: Registration, client: AgentName) {
  const { server } = at;
  register(
    at,
    "send_message",
    {
      description:
        "Send a message to the server agent. Returns msgId, the message's id, which a reply to it gives as replyToMsgId. A refused message was not sent: its error gives the feedback of the rules it broke, or says the server is unavailable, when the same message may be sent again later. Read the reply with receive_messages.",
      input: Schema.Struct(sentFields),
      output: SendReceipt,
    },
    (sent) => server.send("client", client, sent),
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
    ({ cursor }) =>
      Effect.map(server.conversation(client, cursor ?? 0), conversationPage),
  );
}

/**
 * Registers one tool. `execute` handles each call.
 *
 * A successful call returns its value as structured content. A `Failure`
 * returns an error result with the failure's message and fields. Any other
 * error is logged and returns a fixed message that reveals nothing about the
 * cause. A call is interrupted when its request is aborted.
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

/** Converts a failure to an error result. The message becomes the text and the other fields become the structured content. */
function failed(failure: Failure) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: failure.message }],
    structuredContent: Object.fromEntries(
      Object.entries(failure).filter(
        ([field, value]) =>
          field !== "_tag" && field !== "message" && value !== undefined,
      ),
    ),
  };
}

/**
 * Converts an Effect schema to the Standard Schema form the MCP SDK takes.
 * The SDK needs a JSON Schema alongside the validator, which Effect's own
 * conversion does not include. Unknown fields are rejected.
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
