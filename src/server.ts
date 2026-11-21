/**
 * @file What agents do on the server `sharnessd` runs: a server agent and each
 * of its clients send each other messages and read their inbox and their
 * conversation, and the server agent reads its firewall's decisions. A client
 * has one conversation, with the server agent, so its name identifies it.
 */

import { Data, Duration, Effect, PubSub, Queue, type Redacted } from "effect";
import type {
  CheckRecord,
  Firewall,
  FirewallRefusalReason,
  StructureDetail,
} from "./firewall.js";
import { openDatabase } from "./database.js";
import { type AgentName, Message, type MsgId } from "./messages.js";

/** The most entries one read of an inbox or a conversation returns. */
export const PAGE_SIZE = 50;

/** One message as a host reads it. */
interface InboxEntry {
  readonly message: Message;
}

/** A page of an inbox: its entries, the cursor a read that continues it presents, and whether more entries follow now. */
interface InboxPage {
  readonly entries: readonly InboxEntry[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

/** A page of a conversation, with the cursor of the next page when there is one. */
interface ConversationPage {
  readonly records: readonly InboxEntry[];
  readonly nextCursor?: string;
}

/** A failed operation: what a model reads of it in `message`, and its reason with the failure's other fields, which a host reads. */
export interface Failure {
  readonly message: string;
  readonly reason: string;
}

/** What agents do on an open server. A cursor is a place in an ordered read, as decimal text. */
export interface Server {
  /** The server agent's name. */
  readonly name: AgentName;
  /**
   * Sends one message in `client`'s conversation, from the server agent when
   * `author` is its name and from the client otherwise. A message the
   * firewall refuses, and one the server agent addresses to a client that
   * has not written to it, fails the send.
   */
  readonly send: (
    author: AgentName,
    client: AgentName,
    sent: { readonly text: string; readonly replyToMsgId?: MsgId },
  ) => Effect.Effect<{ readonly id: MsgId }, Failure>;
  /** A page of `reader`'s inbox after `cursor`. Without a cursor the read starts after the newest message and returns none. */
  readonly inbox: (
    reader: AgentName,
    page: { readonly limit: number; readonly cursor?: string },
  ) => Effect.Effect<InboxPage>;
  /** The page of `reader`'s inbox after `cursor`, after waiting up to `wait` seconds for an entry when none follows it. */
  readonly receive: (
    reader: AgentName,
    request: { readonly cursor?: string; readonly wait?: number },
  ) => Effect.Effect<InboxPage>;
  /** A page of `client`'s conversation after `cursor`, oldest first. */
  readonly conversation: (
    client: AgentName,
    cursor?: string,
  ) => Effect.Effect<ConversationPage>;
  /** The server agent's page of its conversation with `client`, which must have a message. */
  readonly conversationWith: (
    client: AgentName,
    cursor?: string,
  ) => Effect.Effect<ConversationPage, Failure>;
  /** The client of every conversation, in name order. */
  readonly clients: Effect.Effect<readonly AgentName[]>;
  /** The records of the hundred latest checks since a time, newest first. */
  readonly decisions: (since: number) => Effect.Effect<readonly CheckRecord[]>;
}

const refusalText: Readonly<Record<FirewallRefusalReason, string>> = {
  "rule-violation": "It breaks a rule of the agent's message policy.",
  "unresolved-evidence":
    "The policy check could not settle whether the message is allowed.",
  "check-unavailable": "The policy check could not complete.",
};

/**
 * A send the server agent's firewall refused, whichever agent sent it.
 * `rule` and `detail` are those of a structure check. The message states each deciding rule's feedback as
 * an error, or the reason when there is none, then the check. Feedback is a
 * plain sentence: this message alone marks it as an error.
 */
class FirewallRefusal extends Data.TaggedError("FirewallRefusal")<{
  readonly reason: "firewall-refused";
  readonly checkId: string;
  readonly refusal: FirewallRefusalReason;
  readonly rule?: string;
  readonly feedback: readonly string[];
  readonly detail?: StructureDetail;
}> {
  override get message(): string {
    const rule = this.rule === undefined ? "" : `, rule ${this.rule}`;
    return [
      ...(this.feedback.length === 0
        ? [`Error: ${refusalText[this.refusal]}`]
        : this.feedback.map((text) => `Error: ${text}`)),
      `Check: ${this.checkId}${rule}; ${this.refusal}.`,
    ].join(" ");
  }
}

/** The server agent named a client that has sent it no message, so the two have no conversation. */
class AddressError extends Data.TaggedError("AddressError")<{
  readonly reason: "unknown-agent";
  readonly name: string;
}> {
  override get message(): string {
    return `No client named ${this.name} has written to this agent. Use list_conversations to see the clients that have.`;
  }
}

/**
 * Opens the server on the database at `url` until the scope closes: `name`
 * is its server agent, whose `firewall` checks every message sent.
 */
// eslint-disable-next-line max-lines-per-function -- This function is the scope the operations share: the database, the firewall, the locks and the wake signal. Each function inside it is under the limit.
export const openServer = Effect.fn("openServer")(function* (
  url: Redacted.Redacted,
  name: AgentName,
  firewall: Firewall,
) {
  const database = yield* openDatabase(url, name);
  /** The lock of each conversation a message was sent in, by its client. */
  const conversationLocks = new Map<AgentName, Effect.Semaphore>();
  /** Published with an agent's name each time a message becomes readable for it. */
  const readable = yield* PubSub.unbounded<AgentName>();

  /** Holds `client`'s conversation until the scope closes. */
  const lockConversation = (client: AgentName) =>
    Effect.sync(() => {
      const lock =
        conversationLocks.get(client) ?? Effect.unsafeMakeSemaphore(1);
      conversationLocks.set(client, lock);
      return lock;
    }).pipe(
      Effect.flatMap((lock) =>
        Effect.acquireReleaseInterruptible(lock.take(1), () => lock.release(1)),
      ),
      Effect.asVoid,
    );

  /**
   * A check reads the conversation's earlier messages, so the conversation's
   * lock is held from that read until the message is stored, while other
   * conversations do not wait. No transaction is open while a check runs. A
   * refused message is not stored.
   */
  const send = Effect.fn("send")(
    function* (
      author: AgentName,
      client: AgentName,
      sent: { readonly text: string; readonly replyToMsgId?: MsgId },
    ) {
      const outgoing = author === name;
      yield* lockConversation(client);
      const earlier = yield* database.conversation(client);
      if (outgoing && earlier.length === 0) {
        return yield* new AddressError({
          reason: "unknown-agent",
          name: client,
        });
      }
      const message = yield* Message.create({
        author,
        recipient: outgoing ? client : name,
        text: sent.text,
        replyToMsgId: sent.replyToMsgId,
      });
      const decision = yield* firewall.check(
        outgoing ? "outgoing" : "incoming",
        message,
        earlier,
      );
      if (decision.kind === "refused") {
        if (decision.record !== undefined) {
          yield* database.record(decision.record);
        }
        return yield* new FirewallRefusal({
          reason: "firewall-refused",
          checkId: decision.checkId,
          refusal: decision.reason,
          rule: decision.rule,
          feedback: decision.feedback,
          detail: decision.detail,
        });
      }
      yield* database.store(message, decision.record);
      yield* PubSub.publish(readable, message.recipient);
      return { id: message.msgId };
    },
    Effect.scoped,
    (effect, author) =>
      Effect.tapError(effect, (error) =>
        Effect.logWarning("Send failed").pipe(
          Effect.annotateLogs({
            agentName: author,
            error: error._tag,
            reason: error.message,
          }),
        ),
      ),
  );

  /** The server agent's inbox holds every client's messages; a client's holds the server agent's messages to it. */
  const inbox = Effect.fn("readInbox")(function* (
    reader: AgentName,
    { limit, cursor }: { readonly limit: number; readonly cursor?: string },
  ) {
    const from = Number(cursor ?? (yield* database.newest));
    const stored = yield* database.inbox(reader, from, limit + 1);
    const page = stored.slice(0, limit);
    return {
      entries: page.map(({ message }) => ({ message })),
      nextCursor: String(page.at(-1)?.sequence ?? from),
      hasMore: stored.length > limit,
    };
  });

  /** The read subscribes before it reads, so a wait does not miss an entry that becomes readable after the read. */
  const receive = Effect.fn("receive")(function* (
    reader: AgentName,
    { cursor, wait }: ReceiveRequest,
  ) {
    const woken = yield* PubSub.subscribe(readable);
    const page = yield* inbox(reader, { limit: PAGE_SIZE, cursor });
    if (wait === undefined || page.entries.length > 0) {
      return page;
    }
    yield* Queue.take(woken).pipe(
      Effect.repeat({ until: (woke) => woke === reader }),
      Effect.timeoutOption(Duration.seconds(wait)),
    );
    return yield* inbox(reader, { limit: PAGE_SIZE, cursor: page.nextCursor });
  }, Effect.scoped);

  const conversation = Effect.fn("historyRecords")(function* (
    client: AgentName,
    cursor?: string,
  ) {
    const stored = yield* database.conversation(
      client,
      Number(cursor ?? 0),
      PAGE_SIZE + 1,
    );
    const page = stored.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      records: page.map(({ message }) => ({ message })),
      ...(stored.length > PAGE_SIZE && last !== undefined
        ? { nextCursor: String(last.sequence) }
        : {}),
    };
  });

  const conversationWith = (client: AgentName, cursor?: string) =>
    Effect.gen(function* () {
      const page = yield* conversation(client, cursor);
      if (
        page.records.length === 0 &&
        (yield* database.conversation(client, 0, 1)).length === 0
      ) {
        return yield* new AddressError({
          reason: "unknown-agent",
          name: client,
        });
      }
      return page;
    });

  const server: Server = {
    name,
    send,
    inbox,
    receive,
    conversation,
    conversationWith,
    clients: database.clients,
    decisions: database.decisions,
  };
  return server;
});

interface ReceiveRequest {
  readonly cursor?: string;
  readonly wait?: number;
}
