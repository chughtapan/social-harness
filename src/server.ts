/**
 * @file What agents do on the server `sharnessd` runs: a server agent and each
 * of its clients send each other messages and read their inbox and their
 * conversation, and the server agent reads its firewall's decisions. A client
 * has one conversation, with the server agent, so its name identifies it.
 */

import { Data, Duration, Effect, PubSub, Queue, type Redacted } from "effect";
import type { Firewall } from "./firewall.js";
import type { Role } from "./norms/index.js";
import { openDatabase, type StoredMessage } from "./database.js";
import { type AgentName, Message, type MsgId } from "./messages.js";

/** The most messages one read of an inbox or a conversation returns. */
export const PAGE_SIZE = 50;

/**
 * An operation that failed: `message` is what a model reads of it, and
 * `reason` with the other fields what a host reads.
 */
export interface Failure {
  readonly reason: string;
  readonly message: string;
  readonly name?: string;
  readonly checkId?: string;
  readonly feedback?: readonly string[];
}

class OperationFailure extends Data.TaggedError("OperationFailure")<Failure> {}

/** A message the firewall refused. */
type Refused = Extract<
  Effect.Effect.Success<ReturnType<Firewall["check"]>>,
  { readonly kind: "refused" }
>;

const refusalText: Readonly<Record<Refused["reason"], string>> = {
  violation: "The message breaks a rule of the server's norms.",
  unsure:
    "The decision provider is unsure whether the message follows the server's norms.",
  unavailable: "The check was unavailable.",
};

/**
 * A refusal as the server agent reads its own, and as every refusal is
 * logged: the feedback as errors, or the reason when there is none, then the
 * check, whose record names the rules that refused the message.
 */
function asServerReads({ reason, checkId, feedback }: Refused): Failure {
  const said = feedback.length === 0 ? [refusalText[reason]] : feedback;
  return new OperationFailure({
    reason,
    checkId,
    feedback,
    message: [
      ...said.map((text) => `Error: ${text}`),
      `Check: ${checkId}; ${reason}.`,
    ].join(" "),
  });
}

/**
 * A refusal as the client whose message it refused reads it. A client is not
 * trusted with the check: it reads the feedback and neither the check id nor
 * the firewall's reason, or only that the server is unavailable when the
 * message could not be checked.
 */
function asClientReads({ reason, feedback }: Refused): Failure {
  if (reason === "unavailable") {
    return new OperationFailure({
      reason,
      message: "The server is unavailable. Try again later.",
    });
  }
  const said = feedback.length === 0 ? ["The message was refused."] : feedback;
  return new OperationFailure({
    reason: "refused",
    feedback,
    message: said.map((text) => `Error: ${text}`).join(" "),
  });
}

/** The server agent named a client that has sent it no message, so the two have no conversation. */
function unknownClient(name: AgentName): Failure {
  return new OperationFailure({
    reason: "unknown-client",
    name,
    message: `No client named ${name} has written to this agent. Use list_conversations to see the clients that have.`,
  });
}

/** Fails a send with what its sender `reads`, after logging what the server agent would read of it. */
function failSend(author: AgentName, logged: Failure, reads = logged) {
  return Effect.logWarning("Send failed").pipe(
    Effect.annotateLogs({ agentName: author, reason: logged.message }),
    Effect.andThen(Effect.fail(reads)),
  );
}

/**
 * Opens the server on the database at `url` until the scope closes: `name`
 * is its server agent, whose `firewall` checks every message sent. A read
 * takes the place `after` which it starts and returns a page: its messages,
 * the place `next` of the read that continues it, and whether `more` follow
 * now.
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
   * Sends one message in `client`'s conversation, from the member `sender`
   * names. A check reads the conversation's earlier messages, so the
   * conversation's lock is held from that read until the message is stored,
   * while other conversations do not wait. No transaction is open while a
   * check runs. A refused message is not stored, and neither is one the
   * server agent addresses to a client that has not written to it.
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
      const forServer = asServerReads(decision);
      return yield* failSend(
        author,
        forServer,
        sender === "server" ? forServer : asClientReads(decision),
      );
    }
    yield* database.store(message, decision.record);
    yield* PubSub.publish(readable, message.recipient);
    return { msgId: message.msgId };
  }, Effect.scoped);

  /**
   * At most `limit` messages of `reader`'s inbox after the place `after`.
   * The server agent's inbox has every client's messages; a client's has the
   * server agent's messages to it. Without `after` the read starts after the
   * newest message and returns none.
   */
  const inbox = Effect.fn("readInbox")(function* (
    reader: AgentName,
    { limit, after }: { readonly limit: number; readonly after?: number },
  ) {
    const from = after ?? (yield* database.newest);
    return pageOf(yield* database.inbox(reader, from, limit + 1), limit, from);
  });

  /**
   * A page of `reader`'s inbox after `after`, after waiting up to `wait`
   * seconds for a message when none follows it. The read subscribes before it
   * reads, so a wait does not miss a message that becomes readable after the
   * read.
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

  /** A page of `client`'s conversation after `after`, oldest first. */
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
    /** The server agent's page of its conversation with `client`, which must have written to it. */
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

/** What agents do on an open server. */
export type Server = Effect.Effect.Success<ReturnType<typeof openServer>>;

/** The first `limit` of `stored` as a page read from the place `from`. */
function pageOf(stored: readonly StoredMessage[], limit: number, from: number) {
  const page = stored.slice(0, limit);
  return {
    messages: page.map(({ message }) => message),
    next: page.at(-1)?.sequence ?? from,
    more: stored.length > limit,
  };
}

/** Locks `client`'s conversation, whose lock is one of `locks`, until the scope closes. */
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
