/**
 * @file The server's operations: sending a message, reading an inbox and
 * reading a conversation. A conversation is between the server agent and one
 * client, so the client's name identifies it.
 */

import { Duration, Effect, PubSub, Queue, type Redacted } from "effect";
import type { Firewall } from "./firewall.js";
import type { Role } from "./norms/index.js";
import { openDatabase, type StoredMessage } from "./database.js";
import { type AgentName, Message, type MsgId } from "./messages.js";

/** The largest number of messages a read returns. */
export const PAGE_SIZE = 50;

/**
 * A failed operation. `message` is the text shown to the agent's model.
 * `reason` and the optional fields are for the host, the program that
 * connects the agent to this server.
 */
export interface Failure {
  readonly reason: string;
  readonly message: string;
  readonly name?: string;
  readonly checkId?: string;
  readonly feedback?: readonly string[];
}

/** A message the firewall refused. */
type Refused = Extract<
  Effect.Effect.Success<ReturnType<Firewall["check"]>>,
  { readonly kind: "refused" }
>;

/**
 * The failure to return to the sender of a refused message.
 *
 * The server agent gets the feedback, the check id and the firewall's reason.
 * A client gets the feedback and the reason `refused`, but not the check id
 * or the firewall's reason. If the check was unavailable, a client is told
 * only that the server is unavailable.
 */
function refusalFor(sender: Role, refused: Refused): Failure {
  const { reason, checkId, feedback } = refused;
  const errors = feedback.map((text) => `Error: ${text}`).join(" ");
  if (sender === "server") {
    const said =
      reason === "unavailable" ? "Error: The check was unavailable." : errors;
    return {
      reason,
      checkId,
      feedback,
      message: `${said} Check: ${checkId}; ${reason}.`,
    };
  }
  return reason === "unavailable"
    ? { reason, message: "The server is unavailable. Try again later." }
    : { reason: "refused", feedback, message: errors };
}

/** The failure for a client name that has no conversation with the server agent. */
function unknownClient(name: AgentName): Failure {
  return {
    reason: "unknown-client",
    name,
    message: `No client named ${name} has written to this agent. Use list_conversations to see the clients that have.`,
  };
}

/** Logs `logged`, then fails the send with `reads`, the failure the sender is given. For a client's refused send, `logged` is the fuller version the server agent would get. */
function failSend(author: AgentName, logged: Failure, reads = logged) {
  return Effect.logWarning("Send failed").pipe(
    Effect.annotateLogs({ agentName: author, reason: logged.message }),
    Effect.andThen(Effect.fail(reads)),
  );
}

/**
 * Opens the server on the database at `url`. It stays open until the scope
 * closes. `name` is the server agent's name, and `firewall` checks every
 * message before it is stored.
 *
 * Reads are paged by place: a message's place is its position in the order
 * messages were stored. A read returns the messages after the place `after`,
 * the place `next` to continue from, and `more`, which says whether more
 * messages follow.
 */
export const openServer = Effect.fn("openServer")(function* (
  url: Redacted.Redacted,
  name: AgentName,
  firewall: Firewall,
) {
  const database = yield* openDatabase(url, name);
  /** One lock per conversation, keyed by client name. */
  const conversationLocks = new Map<AgentName, Effect.Semaphore>();
  /** Receives an agent's name each time a new message is stored for that agent. */
  const readable = yield* PubSub.unbounded<AgentName>();

  /**
   * Sends one message in `client`'s conversation. `sender` says which member
   * is sending: the client or the server agent.
   *
   * The firewall's check depends on the conversation's earlier messages, so
   * the conversation's lock is held from reading them until the new message
   * is stored. The lock blocks other sends in the same conversation. It does
   * not block reads or other conversations, and no database transaction is
   * held open during the check. A refused message is not stored. The
   * server agent cannot write to a client that has not written first.
   */
  const send = Effect.fn("send")(function* (
    sender: Role,
    client: AgentName,
    sent: { readonly text: string; readonly replyToMsgId?: MsgId },
  ) {
    const author = sender === "server" ? name : client;
    yield* lockConversation(conversationLocks, client);
    const earlier = yield* database.conversation(client);
    if (sender === "server" && earlier.length === 0) {
      return yield* failSend(author, unknownClient(client));
    }
    const message = yield* Message.create({
      author,
      recipient: sender === "server" ? client : name,
      text: sent.text,
      replyToMsgId: sent.replyToMsgId,
    }).pipe(Effect.catchAll((invalid) => failSend(author, invalid)));
    const decision = yield* firewall.check(sender, message, earlier);
    if (decision.kind === "refused") {
      if (decision.record !== undefined) {
        yield* database.record(decision.record);
      }
      return yield* failSend(
        author,
        refusalFor("server", decision),
        refusalFor(sender, decision),
      );
    }
    yield* database.store(message, decision.record);
    yield* PubSub.publish(readable, message.recipient);
    return { msgId: message.msgId };
  }, Effect.scoped);

  /**
   * Reads up to `limit` messages from `reader`'s inbox. The server agent's
   * inbox holds the messages from every client. A client's inbox holds the
   * server agent's messages to that client. Without `after`, the read starts
   * after the newest message.
   */
  const inbox = Effect.fn("readInbox")(function* (
    reader: AgentName,
    { limit, after }: { readonly limit: number; readonly after?: number },
  ) {
    const from = after ?? (yield* database.newest);
    return pageOf(yield* database.inbox(reader, from, limit + 1), limit, from);
  });

  /**
   * Reads a page of `reader`'s inbox. If the page is empty and `wait` is
   * given, waits up to `wait` seconds for a message and reads again.
   *
   * It subscribes to new messages before the first read, so a message stored
   * between the read and the wait is not missed.
   */
  const receive = Effect.fn("receive")(function* (
    reader: AgentName,
    { after, wait }: { readonly after?: number; readonly wait?: number },
  ) {
    const woken = yield* PubSub.subscribe(readable);
    const page = yield* inbox(reader, { limit: PAGE_SIZE, after });
    if (wait === undefined || page.messages.length > 0) {
      return page;
    }
    yield* Queue.take(woken).pipe(
      Effect.repeat({ until: (woke) => woke === reader }),
      Effect.timeoutOption(Duration.seconds(wait)),
    );
    return yield* inbox(reader, { limit: PAGE_SIZE, after: page.next });
  }, Effect.scoped);

  /** Reads a page of `client`'s conversation, oldest message first. */
  const conversation = Effect.fn("readConversation")(function* (
    client: AgentName,
    after: number,
  ) {
    return pageOf(
      yield* database.conversation(client, after, PAGE_SIZE + 1),
      PAGE_SIZE,
      after,
    );
  });

  return {
    /** The server agent's name. */
    name,
    send,
    inbox,
    receive,
    conversation,
    /** Reads a conversation for the server agent. Fails if `client` has not written to it. */
    conversationWith: (client: AgentName, after: number) =>
      Effect.flatMap(database.clients, (clients) =>
        clients.includes(client)
          ? conversation(client, after)
          : Effect.fail(unknownClient(client)),
      ),
    clients: database.clients,
    records: database.records,
  };
});

/** The operations of an open server. */
export type Server = Effect.Effect.Success<ReturnType<typeof openServer>>;

/** Builds a page from `stored`, which holds one message more than `limit` when more messages follow. `from` is the place the read started at. */
function pageOf(stored: readonly StoredMessage[], limit: number, from: number) {
  const page = stored.slice(0, limit);
  return {
    messages: page.map(({ message }) => message),
    next: page.at(-1)?.sequence ?? from,
    more: stored.length > limit,
  };
}

/** Locks `client`'s conversation until the scope closes, creating its lock in `locks` on first use. */
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
