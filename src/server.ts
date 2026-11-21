/**
 * @file What agents do on the server `sharnessd` runs: a server agent and each
 * of its clients send each other messages and read their inbox and their
 * conversation, and the server agent reads its firewall's decisions. A client
 * has one conversation, with the server agent, so its name identifies it.
 */

import {
  Data,
  Duration,
  Effect,
  PubSub,
  Queue,
  type Redacted,
  Schema,
} from "effect";
import type { CheckRecord, Firewall, RefusalReason } from "./firewall.js";
import { openDatabase, type StoredMessage } from "./database.js";
import { type AgentName, Message, MsgId } from "./messages.js";

/** The most entries one read of an inbox or a conversation returns. */
export const PAGE_SIZE = 50;

/** A place in an ordered read, as decimal text. A read returns what follows it. */
export const Cursor = Schema.String.pipe(Schema.pattern(/^\d{1,15}$/u));

/** One message as a host reads it, from an inbox or a conversation. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The inbox event carries an entry as it stands, and needs its schema to publish it.
export const Entry: Schema.Schema<
  { readonly message: Message },
  { readonly message: Schema.Schema.Encoded<typeof Message> }
> = Schema.Struct({ message: Message });

const pageOfEntries = Schema.Array(Entry).pipe(Schema.maxItems(PAGE_SIZE));

/** A page of an inbox: its entries, the cursor a read that continues it presents, and whether more entries follow now. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The receive_messages tool returns a page as it stands, and needs its schema to publish it.
export const InboxPage = Schema.Struct({
  entries: pageOfEntries,
  nextCursor: Cursor,
  hasMore: Schema.Boolean,
});
type InboxPage = typeof InboxPage.Type;

/** A page of a conversation: its entries, and the cursor of the next page when there is one. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The read_conversation tool returns a page as it stands, and needs its schema to publish it.
export const ConversationPage = Schema.Struct({
  entries: pageOfEntries,
  nextCursor: Schema.optional(Cursor),
});
type ConversationPage = typeof ConversationPage.Type;

/** What a send returns: the id its message was stored under. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The send_message tool returns this as it stands, and needs its schema to publish it.
export const SendReceipt = Schema.Struct({ id: MsgId });

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
   * has not written to it, fails the send. A client's failure says only what
   * a sender may know.
   */
  readonly send: (
    author: AgentName,
    client: AgentName,
    sent: { readonly text: string; readonly replyToMsgId?: MsgId },
  ) => Effect.Effect<typeof SendReceipt.Type, Failure>;
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

const refusalText: Readonly<Record<RefusalReason, string>> = {
  "rule-violation": "The message breaks a rule of the server's norms.",
  "unresolved-evidence":
    "The check could not settle whether the message follows the server's norms.",
  "check-unavailable": "The check could not complete.",
};

/**
 * A send the server agent's firewall refused, as the server agent reads its
 * own and as the daemon logs every one. The message states the feedback as
 * errors, or the reason when there is none, then the check, whose record
 * names the rules that refused it. Feedback is a plain sentence: this
 * message alone marks it as an error.
 */
class FirewallRefusal extends Data.TaggedError("FirewallRefusal")<{
  readonly reason: RefusalReason;
  readonly checkId: string;
  readonly feedback: readonly string[];
}> {
  override get message(): string {
    return [
      ...(this.feedback.length === 0
        ? [`Error: ${refusalText[this.reason]}`]
        : this.feedback.map((text) => `Error: ${text}`)),
      `Check: ${this.checkId}; ${this.reason}.`,
    ].join(" ");
  }
}

/**
 * A refusal of a client's send, as the client reads it. A client is not
 * trusted with the check behind a refusal: it reads the feedback, which says
 * what in the message does not fit the norm, and neither the check id nor
 * the firewall's reason.
 */
class RefusalToClient extends Data.TaggedError("RefusalToClient")<{
  readonly reason: "refused";
  readonly feedback: readonly string[];
}> {
  override get message(): string {
    const said =
      this.feedback.length === 0
        ? ["The message was not accepted."]
        : this.feedback;
    return said.map((text) => `Error: ${text}`).join(" ");
  }
}

/** What a client reads when the server could not check its message: nothing of why. */
class UnavailableToClient extends Data.TaggedError("UnavailableToClient")<{
  readonly reason: "unavailable";
}> {
  override get message(): string {
    return "The server is unavailable. Try again later.";
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

  /**
   * A check reads the conversation's earlier messages, so the conversation's
   * lock is held from that read until the message is stored, while other
   * conversations do not wait. No transaction is open while a check runs. A
   * refused message is not stored. A failure is logged as the server agent
   * would read it, before a client reads its part of it.
   */
  const send = Effect.fn("send")(
    function* (
      author: AgentName,
      client: AgentName,
      sent: { readonly text: string; readonly replyToMsgId?: MsgId },
    ) {
      const fromServer = author === name;
      yield* lockConversation(conversationLocks, client);
      const earlier = yield* database.conversation(client);
      if (fromServer && earlier.length === 0) {
        return yield* new AddressError({
          reason: "unknown-agent",
          name: client,
        });
      }
      const message = yield* Message.create({
        author,
        recipient: fromServer ? client : name,
        text: sent.text,
        replyToMsgId: sent.replyToMsgId,
      });
      const decision = yield* firewall.check(
        fromServer ? "server" : "client",
        message,
        earlier,
      );
      if (decision.kind === "refused") {
        if (decision.record !== undefined) {
          yield* database.record(decision.record);
        }
        return yield* refusalOf(decision);
      }
      yield* database.store(message, decision.record);
      yield* PubSub.publish(readable, message.recipient);
      return { id: message.msgId };
    },
    Effect.scoped,
    logFailedSend,
    (sending, author) =>
      author === name
        ? sending
        : Effect.catchTag(sending, "FirewallRefusal", (refusal) =>
            Effect.fail(asClientReads(refusal)),
          ),
  );

  /** The server agent's inbox has every client's messages; a client's has the server agent's messages to it. */
  const inbox = Effect.fn("readInbox")(function* (
    reader: AgentName,
    { limit, cursor }: { readonly limit: number; readonly cursor?: string },
  ) {
    const from = Number(cursor ?? (yield* database.newest));
    const { entries, last, more } = pageOf(
      yield* database.inbox(reader, from, limit + 1),
      limit,
    );
    return { entries, nextCursor: String(last ?? from), hasMore: more };
  });

  /** The read subscribes before it reads, so a wait does not miss an entry that becomes readable after the read. */
  const receive = Effect.fn("receive")(function* (
    reader: AgentName,
    { cursor, wait }: Parameters<Server["receive"]>[1],
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

  const conversation = Effect.fn("readConversation")(function* (
    client: AgentName,
    cursor?: string,
  ) {
    const { entries, last, more } = pageOf(
      yield* database.conversation(client, Number(cursor ?? 0), PAGE_SIZE + 1),
      PAGE_SIZE,
    );
    return {
      entries,
      ...(more && last !== undefined ? { nextCursor: String(last) } : {}),
    };
  });

  const conversationWith = (client: AgentName, cursor?: string) =>
    Effect.gen(function* () {
      const page = yield* conversation(client, cursor);
      if (
        page.entries.length === 0 &&
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

/** The firewall's refusal of a message as its send's failure. */
function refusalOf(
  decision: Extract<
    Effect.Effect.Success<ReturnType<Firewall["check"]>>,
    { readonly kind: "refused" }
  >,
) {
  return new FirewallRefusal({
    reason: decision.reason,
    checkId: decision.checkId,
    feedback: decision.feedback,
  });
}

/**
 * A refusal as the client whose message it refused reads it: only the
 * feedback, or that the server is unavailable when the message could not be
 * checked.
 */
function asClientReads(refusal: FirewallRefusal) {
  return refusal.reason === "check-unavailable"
    ? new UnavailableToClient({ reason: "unavailable" })
    : new RefusalToClient({ reason: "refused", feedback: refusal.feedback });
}

/** The first `limit` of `stored` as entries, the place of the last of them, and whether more were stored. */
function pageOf(stored: readonly StoredMessage[], limit: number) {
  const page = stored.slice(0, limit);
  return {
    entries: page.map(({ message }) => ({ message })),
    last: page.at(-1)?.sequence,
    more: stored.length > limit,
  };
}

/** Holds `client`'s conversation, whose lock is one of `locks`, until the scope closes. */
function lockConversation(
  locks: Map<AgentName, Effect.Semaphore>,
  client: AgentName,
) {
  return Effect.sync(() => {
    const lock = locks.get(client) ?? Effect.unsafeMakeSemaphore(1);
    locks.set(client, lock);
    return lock;
  }).pipe(
    Effect.flatMap((lock) =>
      Effect.acquireReleaseInterruptible(lock.take(1), () => lock.release(1)),
    ),
    Effect.asVoid,
  );
}

/** Logs a send that failed, with the agent that sent it. */
function logFailedSend<
  A,
  E extends { readonly _tag: string; readonly message: string },
  R,
>(send: Effect.Effect<A, E, R>, author: AgentName) {
  return Effect.tapError(send, (error) =>
    Effect.logWarning("Send failed").pipe(
      Effect.annotateLogs({
        agentName: author,
        error: error._tag,
        reason: error.message,
      }),
    ),
  );
}
