/**
 * @file What a test does as an agent's host: call the server's tools over an
 * MCP connection and read their results. The helpers drive a server in the
 * test's own process and a `sharnessd` process alike.
 */

import type { Client } from "@modelcontextprotocol/client";
import { Effect, Schema } from "effect";
import { checkRecordSchema } from "../../src/firewall.js";
import { AgentName, Message, MsgId } from "../../src/messages.js";

/** A signed-in owner: its agent's name and an MCP connection as it. */
export interface SignedIn {
  readonly name: AgentName;
  readonly mcp: Client;
}

const fields = Schema.decodeUnknownSync(
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);

/** An entry as a host reads it. */
const entry = Schema.Struct({
  message: Message,
});

/** Reads an entry from what the inbox event delivers. */
export const decodeEntry = Schema.decodeUnknown(entry);

/** What tests read of the result of each tool they call. */
const results = {
  status: Schema.Struct({ agentName: AgentName }),
  send_message: Schema.Struct({ msgId: MsgId }),
  receive_messages: Schema.Struct({
    entries: Schema.Array(entry),
    nextCursor: Schema.String,
  }),
  list_conversations: Schema.Struct({ clients: Schema.Array(Schema.String) }),
  read_conversation: Schema.Struct({
    entries: Schema.Array(entry),
    nextCursor: Schema.optional(Schema.String),
  }),
  read_firewall_decisions: Schema.Struct({
    decisions: Schema.Array(checkRecordSchema),
  }),
};
type ToolName = keyof typeof results;

export function callTool<Name extends ToolName>(
  agent: Pick<SignedIn, "mcp">,
  name: Name,
  input?: object,
): Effect.Effect<
  (typeof results)[Name]["Type"],
  Readonly<Record<string, unknown>>
>;
/**
 * Calls a tool as `agent` and decodes its result. A call the server answers
 * as failed fails with the result's structured fields and, as `message`, the
 * text a model reads. Interrupting the call aborts its request.
 */
export function callTool(
  agent: Pick<SignedIn, "mcp">,
  name: ToolName,
  input: object = {},
): Effect.Effect<unknown, Readonly<Record<string, unknown>>> {
  const output: Schema.Schema.AnyNoContext = results[name];
  return Effect.tryPromise((signal) =>
    agent.mcp.callTool({ name, arguments: { ...input } }, { signal }),
  ).pipe(
    Effect.orDie,
    Effect.flatMap((result) =>
      result.isError === true
        ? Effect.fail({
            ...fields(result.structuredContent ?? {}),
            message: result.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n"),
          })
        : Schema.decodeUnknown(output)(result.structuredContent).pipe(
            Effect.map((decoded): unknown => decoded),
            Effect.orDie,
          ),
    ),
  );
}

/** Sends a message as `sender`. The server agent names its recipient in `to`; a client names none. */
export const send = (
  sender: Pick<SignedIn, "mcp">,
  input: {
    readonly to?: string;
    readonly text: string;
    readonly replyToMsgId?: MsgId;
  },
) => callTool(sender, "send_message", input);

/** The messages of the first page of the agent's inbox, from its first entry. */
export const inboxOf = (agent: Pick<SignedIn, "mcp">) =>
  Effect.map(callTool(agent, "receive_messages", { cursor: "0" }), (page) =>
    page.entries.map(({ message }) => message),
  );
