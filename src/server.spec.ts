/**
 * @file What agents observe of the server through their tools: the tools of
 * their role, each call's result or failure, sends and their checks, the
 * inbox, history and conversations; and what opening it does to its
 * database.
 */

import { scopedLive as it } from "@effect/vitest";
import {
  Array as Arr,
  Deferred,
  Effect,
  Either,
  FastCheck as fc,
  Fiber,
  Order,
  Schema,
} from "effect";
import { expect } from "vitest";
import type { DecisionRequest } from "./decision-provider.js";
import type { Firewall } from "./firewall.js";
import { openTestDatabase } from "../tests/support/database.js";
import {
  type Answering,
  answersTo,
} from "../tests/support/decision-provider.js";
import {
  callTool,
  inboxOf,
  send,
  type SignedIn,
} from "../tests/support/host.js";
import { inProcessServer } from "../tests/support/in-process-server.js";
import { prepareTables } from "./database.js";
import { compileNorms } from "./norms/index.js";

/** The text of the message a provider is asked to judge. */
const candidateText = (request: DecisionRequest) =>
  Schema.decodeUnknownSync(
    Schema.parseJson(
      Schema.Struct({ candidate: Schema.Struct({ text: Schema.String }) }),
    ),
  )(request.state).candidate.text;

/** A firewall that allows every message a client sends and decides each of the server agent's with `decide`. */
const decidingServerMessages = (
  decide: () => ReturnType<Firewall["check"]>,
): Firewall => ({
  check: (sender) =>
    sender === "server" ? decide() : Effect.succeed({ kind: "allowed" }),
});

it("gives the server agent its tools, and a status result that names the agent", () =>
  Effect.gen(function* () {
    const server = yield* inProcessServer();
    const alice = yield* server.signInAs("alice");
    const { tools } = yield* Effect.tryPromise(() => alice.mcp.listTools());
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set([
        "list_conversations",
        "read_conversation",
        "read_firewall_decisions",
        "receive_messages",
        "send_message",
        "status",
      ]),
    );
    const reply = yield* Effect.tryPromise(() =>
      alice.mcp.callTool({ name: "status", arguments: {} }),
    );
    expect(reply.structuredContent).toEqual({ agentName: "alice" });
    expect(reply.content).toEqual([
      { type: "text", text: JSON.stringify(reply.structuredContent) },
    ]);
  }));

it("gives a client tools that name no recipient and no conversation", () =>
  Effect.gen(function* () {
    const server = yield* inProcessServer();
    const bob = yield* server.signInAs("bob");
    const { tools } = yield* Effect.tryPromise(() => bob.mcp.listTools());
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set([
        "read_conversation",
        "receive_messages",
        "send_message",
        "status",
      ]),
    );
    expect(
      Object.keys(
        tools.find((tool) => tool.name === "send_message")?.inputSchema
          .properties ?? {},
      ),
    ).toEqual(["text", "replyToMsgId"]);
    const { msgId } = yield* send(bob, { text: "hello" });
    expect((yield* callTool(bob, "read_conversation")).entries).toEqual([
      {
        message: {
          author: bob.name,
          recipient: "alice",
          msgId,
          text: "hello",
        },
      },
    ]);
  }));

it("refuses a call with a wrong or an unknown argument without running the tool", () =>
  Effect.gen(function* () {
    const server = yield* inProcessServer();
    const alice = yield* server.signInAs("alice");
    for (const wrong of [{ text: 1 }, { extra_field: "x" }]) {
      const failure = yield* callTool(alice, "send_message", {
        to: "bob",
        text: "hello",
        ...wrong,
      }).pipe(Effect.flip);
      expect(failure.message).toContain(Object.keys(wrong)[0]);
    }
  }));

it("answers a failed call with the failure's message and its fields", () =>
  Effect.gen(function* () {
    const refusals = [
      {
        reason: "violation" as const,
        checkId: "chk_1",
        feedback: ["Send a greeting first."],
      },
      {
        reason: "unsure" as const,
        checkId: "chk_2",
        feedback: ["Say only what the greeting needs."],
      },
    ];
    const pending = [...refusals];
    const server = yield* inProcessServer({
      firewall: decidingServerMessages(() =>
        Effect.map(Effect.fromNullable(pending.shift()), (next) => ({
          kind: "refused" as const,
          ...next,
        })).pipe(Effect.orDie),
      ),
    });
    const alice = yield* server.signInAs("alice");
    const bob = yield* server.signInAs("bob");
    yield* send(bob, { text: "hi" });
    const said: Readonly<Record<string, string>> = {
      chk_1: "Error: Send a greeting first. Check: chk_1; violation.",
      chk_2: "Error: Say only what the greeting needs. Check: chk_2; unsure.",
    };
    for (const fields of refusals) {
      expect(
        yield* send(alice, { to: bob.name, text: "hello" }).pipe(Effect.flip),
      ).toEqual({ ...fields, message: said[fields.checkId] });
    }
    for (const name of ["nobody", "alice"]) {
      const refusal = {
        reason: "unknown-client",
        name,
        message: `No client named ${name} has written to this agent. Use list_conversations to see the clients that have.`,
      };
      expect(
        yield* Effect.flip(send(alice, { to: name, text: "hello" })),
      ).toEqual(refusal);
      expect(
        yield* Effect.flip(
          callTool(alice, "read_conversation", { with: name }),
        ),
      ).toEqual(refusal);
    }
  }));

it("answers a call that dies without the defect's text", () =>
  Effect.gen(function* () {
    const server = yield* inProcessServer({
      firewall: decidingServerMessages(() =>
        Effect.dieMessage("PRIVATE relation does not exist"),
      ),
    });
    const alice = yield* server.signInAs("alice");
    const bob = yield* server.signInAs("bob");
    yield* send(bob, { text: "hi" });
    const died = yield* send(alice, { to: bob.name, text: "hello" }).pipe(
      Effect.flip,
    );
    expect(Object.keys(died)).toEqual(["message"]);
    expect(died.message).not.toContain("PRIVATE");
    yield* server.sql`DROP TABLE firewall_checks`;
    const failure = yield* callTool(alice, "read_firewall_decisions").pipe(
      Effect.flip,
    );
    expect(Object.keys(failure)).toEqual(["message"]);
    expect(failure.message).not.toContain("firewall_checks");
  }));

it("interrupts only the aborted call, whose conversation the next send then uses", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<undefined>();
    const interrupted = yield* Deferred.make<undefined>();
    let first = true;
    const server = yield* inProcessServer({
      firewall: decidingServerMessages(() =>
        Effect.suspend(() => {
          if (!first) {
            return Effect.succeed({ kind: "allowed" as const });
          }
          first = false;
          return Deferred.succeed(entered, undefined).pipe(
            Effect.zipRight(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          );
        }),
      ),
    });
    const alice = yield* server.signInAs("alice");
    const bob = yield* server.signInAs("bob");
    yield* send(bob, { text: "hi" });
    const hello = { to: bob.name, text: "hello" };

    const waiting = yield* Effect.fork(send(alice, hello));
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(waiting);
    yield* Deferred.await(interrupted);

    expect(yield* send(alice, hello)).toHaveProperty("msgId");
  }));

/** A norm of one act that either member sends, whose described field gives it the one text rule here. */
const chat = Either.getOrThrow(
  compileNorms([
    `(norm chat)
(act say :by (client server) :starts true :ends true
  (field words :type string :description "Nothing private."))
`,
  ]),
);

/** The act `say` with `words`. */
const say = (words: string) =>
  `(say :norm chat :words ${JSON.stringify(words)})`;

/** What the sender of a `say` that breaks the field's description reads. */
const nothingPrivate =
  "words must contain only what its description says: Nothing private.";

/** A provider that finds a message in violation exactly when it says `private`, whichever member sent it. */
const privateViolation: Answering = {
  answer: (request) =>
    Effect.succeed(
      answersTo(
        request,
        {},
        candidateText(request) === say("private") ? "violation" : "compliant",
      ),
    ),
};

/** A server with its server agent Alice and her client Bob signed in. */
const aliceAndBob = (options?: Parameters<typeof inProcessServer>[0]) =>
  Effect.gen(function* () {
    const server = yield* inProcessServer(options);
    const alice = yield* server.signInAs("alice");
    const bob = yield* server.signInAs("bob");
    return { server, alice, bob };
  });

/** Whether `agent` sent or received each message on the first page of its history with `client`, or with the server agent. */
const historyOf = (agent: SignedIn, client?: string) =>
  Effect.map(
    callTool(agent, "read_conversation", { with: client }),
    ({ entries }) =>
      entries.map((entry) =>
        entry.message.author === agent.name ? "sent" : "received",
      ),
  );

it("stores each send as a new message to the agent it names, with the reply reference it gives", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* aliceAndBob();

    yield* send(bob, { text: "Hello" });
    const first = yield* send(alice, { to: bob.name, text: "Hello" });
    const second = yield* send(alice, {
      to: bob.name,
      text: "Hello",
      replyToMsgId: first.msgId,
    });

    const [stored, reply] = yield* inboxOf(bob);
    expect(stored).toMatchObject({ msgId: first.msgId, recipient: bob.name });
    expect(stored).not.toHaveProperty("replyToMsgId");
    expect(reply).toMatchObject({
      msgId: second.msgId,
      replyToMsgId: first.msgId,
    });
  }));

it("checks the messages of one conversation in order while another conversation progresses", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const assessed: string[] = [];
    const { server, alice, bob } = yield* aliceAndBob({
      norms: chat,
      provider: {
        answer: (request) =>
          Effect.gen(function* () {
            const text = candidateText(request);
            assessed.push(text);
            if (text === say("First")) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return answersTo(request);
          }),
      },
    });
    const carol = yield* server.signInAs("carol");
    const authors = Effect.map(inboxOf(alice), (messages) =>
      messages.map((message) => message.author),
    );

    const first = yield* Effect.forkScoped(send(bob, { text: say("First") }));
    yield* Deferred.await(entered);
    const second = yield* Effect.forkScoped(send(bob, { text: say("Second") }));
    yield* send(carol, { text: say("Independent") });

    expect(yield* authors).toEqual([carol.name]);
    expect(assessed).toEqual([say("First"), say("Independent")]);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.joinAll([first, second]);
    expect(yield* authors).toEqual([carol.name, bob.name, bob.name]);
    expect(assessed).toEqual([say("First"), say("Independent"), say("Second")]);
  }));

it("reads the inbox a page of fifty at a time after a cursor, the same page again for the same cursor, and nothing earlier without one", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* aliceAndBob();
    const receive = (cursor?: string) =>
      callTool(alice, "receive_messages", { cursor });
    const start = yield* receive();
    expect(start.entries).toEqual([]);
    const sent = yield* Effect.forEach(
      Array.from({ length: 57 }),
      () => Effect.map(send(bob, { text: "Hello" }), ({ msgId }) => msgId),
      { concurrency: 1 },
    );

    const first = yield* receive(start.nextCursor);
    const rest = yield* receive(first.nextCursor);

    expect(first.entries.map((entry) => entry.message.msgId)).toEqual(
      sent.slice(0, 50),
    );
    expect(rest.entries.map((entry) => entry.message.msgId)).toEqual(
      sent.slice(50),
    );
    expect(yield* receive(first.nextCursor)).toEqual(rest);
    expect(yield* receive()).toEqual({
      entries: [],
      nextCursor: rest.nextCursor,
    });
  }));

it("fails a send whose described field breaks its description, telling the server agent the whole refusal and a client only the feedback, and keeps the decision but not the message", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* aliceAndBob({
      norms: chat,
      provider: privateViolation,
    });
    yield* send(bob, { text: say("hello") });

    expect(yield* Effect.flip(send(bob, { text: say("private") }))).toEqual({
      reason: "refused",
      feedback: [nothingPrivate],
      message: `Error: ${nothingPrivate}`,
    });
    expect(
      yield* Effect.flip(send(alice, { to: bob.name, text: say("private") })),
    ).toMatchObject({
      reason: "violation",
      feedback: [nothingPrivate],
    });

    const refusedBy = {
      client: bob.name,
      decision: "refused",
      reason: "violation",
      refusedBy: [{ ruleId: "chat.say.words", feedback: nothingPrivate }],
    };
    expect(
      (yield* callTool(alice, "read_firewall_decisions")).decisions,
    ).toMatchObject([
      { sender: "server", ...refusedBy },
      { sender: "client", ...refusedBy },
      { sender: "client", client: bob.name, decision: "allowed" },
    ]);
    expect(yield* historyOf(bob)).toEqual(["sent"]);
    expect(yield* inboxOf(bob)).toEqual([]);
  }));

it("tells a client only that the server is unavailable, and stores nothing, when the check of its message could not run", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* aliceAndBob({
      norms: chat,
      provider: { answer: () => Effect.succeed({ answers: {} }) },
    });

    expect(yield* send(bob, { text: say("Hello") }).pipe(Effect.flip)).toEqual({
      reason: "unavailable",
      message: "The server is unavailable. Try again later.",
    });

    expect(
      (yield* callTool(alice, "read_firewall_decisions")).decisions,
    ).toEqual([]);
    expect(yield* historyOf(bob)).toEqual([]);
  }));

/** The client's `open` starts an instance and the server's `close` ends it. */
const exchange = Either.getOrThrow(
  compileNorms([
    `(norm exchange)
(act open :by client :starts true :sets opened)
(act close :by server :when opened :ends true)
`,
  ]),
);

it("refuses what the norms a server publishes do not accept, plain text and an act out of turn alike, telling the client only what to correct, and the conversation goes on", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* aliceAndBob({ norms: exchange });

    for (const text of ["Hello, can you help?", "(close :norm exchange)"]) {
      const refusal = yield* send(bob, { text }).pipe(Effect.flip);
      expect(refusal.reason).toBe("refused");
      expect(new Set(Object.keys(refusal))).toEqual(
        new Set(["reason", "feedback", "message"]),
      );
    }
    yield* send(bob, { text: "(open :norm exchange)" });
    expect(yield* inboxOf(alice)).toHaveLength(1);
  }));

it("checks each act of a norm against the whole conversation, though the provider's history window has one message", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* aliceAndBob({
      historyLimit: 1,
      norms: exchange,
    });

    for (let instance = 0; instance < 3; instance += 1) {
      const opened = yield* send(bob, { text: "(open :norm exchange)" });
      yield* send(alice, {
        to: bob.name,
        text: "(close :norm exchange)",
        replyToMsgId: opened.msgId,
      });
    }

    expect(yield* inboxOf(alice)).toHaveLength(3);
  }));

it("continues a conversation's history from the cursor a page returned, with what was sent since", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* aliceAndBob();
    const say = (text: string) => send(bob, { text });
    for (let index = 0; index < 51; index += 1) {
      yield* say(`Message ${index}`);
    }

    const first = yield* callTool(alice, "read_conversation", {
      with: bob.name,
    });
    yield* say("Later message");
    const rest = yield* callTool(alice, "read_conversation", {
      with: bob.name,
      cursor: first.nextCursor,
    });

    expect(first.entries).toHaveLength(50);
    expect(rest.entries.map((entry) => entry.message.text)).toEqual([
      "Message 50",
      "Later message",
    ]);
    expect(rest.nextCursor).toBeUndefined();
  }));

it("lists every conversation once, in name order", () =>
  Effect.gen(function* () {
    const server = yield* inProcessServer();
    const alice = yield* server.signInAs("alice");
    const clients: string[] = [];
    for (const owner of ["one", "two", "three", "two"]) {
      const client = yield* server.signInAs(owner);
      yield* send(client, { text: "Hello" });
      clients.push(client.name);
    }

    expect(yield* callTool(alice, "list_conversations")).toEqual({
      clients: [...new Set(clients)].sort(Order.string),
    });
  }));

it("prepares an empty database and leaves a prepared one as it is", () =>
  Effect.gen(function* () {
    const database = yield* openTestDatabase();
    yield* prepareTables(database.sql);
    yield* database.sql`INSERT INTO firewall_checks (checked_at, record) VALUES (1, 'kept')`;
    yield* prepareTables(database.sql);
    expect(yield* database.sql`SELECT record FROM firewall_checks`).toEqual([
      { record: "kept" },
    ]);
    expect(yield* database.sql`SELECT * FROM messages`).toEqual([]);
  }));

it("rejects a database whose tables another version of the server created", () =>
  Effect.gen(function* () {
    const database = yield* openTestDatabase();
    yield* prepareTables(database.sql);
    yield* database.sql`ALTER TABLE firewall_checks RENAME COLUMN checked_at TO decided_at`;

    expect(yield* prepareTables(database.sql).pipe(Effect.flip)).toMatchObject({
      reason: "schema",
    });
  }));

it("rejects a database that has other tables without changing their records", () =>
  Effect.gen(function* () {
    const database = yield* openTestDatabase();
    yield* database.sql`CREATE TABLE retained (value TEXT NOT NULL)`;
    yield* database.sql`INSERT INTO retained VALUES ('prior installation')`;
    expect(yield* prepareTables(database.sql).pipe(Effect.flip)).toMatchObject({
      reason: "schema",
    });
    expect(yield* database.sql`SELECT * FROM retained`).toEqual([
      { value: "prior installation" },
    ]);
    expect(
      yield* database.sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema()`,
    ).toEqual([{ name: "retained" }]);
  }));

const accounts = fc.array(
  fc.record({
    issuer: fc.constantFrom("https://issuer.example", "https://other.example"),
    subject: fc.constantFrom("owner", "another", "third"),
  }),
  { minLength: 1, maxLength: 6 },
);

it.prop(
  "gives each issuer and subject pair one name of its own, however many sign in at once or again",
  [accounts],
  ([owners]) =>
    Effect.gen(function* () {
      const server = yield* inProcessServer();
      const nameOf = (owner: (typeof owners)[number]) =>
        Effect.map(server.signInAs(owner), (signedIn) => signedIn.name);
      const names = yield* Effect.forEach(owners, nameOf, {
        concurrency: owners.length,
      });
      expect(yield* Effect.forEach(owners, nameOf, { concurrency: 1 })).toEqual(
        names,
      );
      expect(
        new Set(
          owners.map(
            (owner, index) =>
              `${owner.issuer} ${owner.subject} ${names[index] ?? ""}`,
          ),
        ).size,
      ).toBe(new Set(names).size);
    }),
  { fastCheck: { numRuns: 10 } },
);

/** A server whose firewall refuses exactly the messages whose text is `refused`, with Alice and two clients signed in. */
const refusingByText = Effect.gen(function* () {
  const check: Firewall["check"] = (...[, message]) =>
    Effect.succeed(
      message.text === "refused"
        ? {
            kind: "refused",
            checkId: "chk_refused",
            reason: "violation",
            feedback: ["Not that."],
          }
        : { kind: "allowed" },
    );
  const server = yield* inProcessServer({
    firewall: { check },
  });
  const alice = yield* server.signInAs("alice");
  const clients = {
    bob: yield* server.signInAs("bob"),
    carol: yield* server.signInAs("carol"),
  };
  /** The ids of the messages Alice may read after `cursor`, in read order, with the cursor to read on from. */
  const inbox = (cursor?: string) =>
    Effect.map(
      callTool(alice, "receive_messages", { cursor }),
      ({ entries, nextCursor }) => ({
        ids: entries.map(({ message }) => message.msgId),
        nextCursor,
      }),
    );
  return { clients, inbox };
});

const steps = fc.array(
  fc.oneof(
    fc.record({
      step: fc.constant("send" as const),
      author: fc.constantFrom("bob" as const, "carol" as const),
      readable: fc.boolean(),
    }),
    fc.record({
      step: fc.constant("read" as const),
      /** Which earlier read's cursor the read presents, counted back from the latest; none when absent. */
      cursor: fc.option(fc.nat({ max: 5 }), { nil: undefined }),
    }),
  ),
  { maxLength: 40 },
);

it("returns, for any cursor a read gave, every message that became readable since that read in the order it did, and none for a read without a cursor", () =>
  Effect.gen(function* () {
    const { clients, inbox } = yield* refusingByText;
    /** The ids of the messages alice may read, in the order they were stored. */
    const expected: string[] = [];
    /** Each cursor a read returned, with the count of messages readable when it did. */
    const cursors: Array<{ cursor: string; through: number }> = [];
    const holds = fc.asyncProperty(steps, (sequence) =>
      Effect.gen(function* () {
        for (const step of sequence) {
          if (step.step === "send") {
            const sender = clients[step.author];
            if (step.readable) {
              expected.push((yield* send(sender, { text: "hello" })).msgId);
            } else {
              yield* Effect.flip(send(sender, { text: "refused" }));
            }
          } else {
            const presented =
              step.cursor === undefined
                ? undefined
                : cursors.at(-1 - step.cursor);
            const read = yield* inbox(presented?.cursor);
            expect(read.ids).toEqual(
              expected.slice(presented?.through ?? expected.length),
            );
            cursors.push({ cursor: read.nextCursor, through: expected.length });
          }
        }
      }).pipe(Effect.runPromise),
    );
    yield* Effect.tryPromise(() => fc.assert(holds, { numRuns: 30 }));
  }));

it("gives messages stored at the same time distinct places in their recipient's read order", () =>
  Effect.gen(function* () {
    const { clients, inbox } = yield* refusingByText;
    const sent = yield* Effect.forEach(
      Arr.makeBy(12, (index) => (index % 2 === 0 ? "bob" : "carol")),
      (author) =>
        Effect.map(
          send(clients[author], { text: "hello" }),
          ({ msgId }) => msgId,
        ),
      { concurrency: 12 },
    );
    const read = yield* inbox("0");
    expect(new Set(read.ids)).toEqual(new Set(sent));
    expect(read.nextCursor).toBe("12");
  }));
