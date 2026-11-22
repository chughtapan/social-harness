/** @file A check maps each text rule's answer to a decision and what its caller saves, whichever member sent the message, and Jev's failures make a check unavailable. */

import { FetchHttpClient } from "@effect/platform";
import { effect as it, live } from "@effect/vitest";
import {
  Effect,
  FastCheck as fc,
  Fiber,
  Redacted,
  Schema,
  TestClock,
} from "effect";
import { describe, expect } from "vitest";
import type { Norms, Role, TextRule } from "./norms/index.js";
import {
  type Answer,
  type Answering,
  answersTo,
} from "../tests/support/decision-provider.js";
import {
  DecisionProviderError,
  type DecisionRequest,
  jevDecisionProvider,
} from "./decision-provider.js";
import { type CheckedMessage, makeFirewall } from "./firewall.js";
import { AgentName, Message } from "./messages.js";

type StructureCheck = Norms["structureCheck"];

const senders = ["client", "server"] as const;

const alice = AgentName.make("alice");
const bob = AgentName.make("bob");
const proposal: TextRule = {
  id: "proposal-acceptance",
  text: "Availability is not acceptance.",
};
/** A rule the provider of `certain` always finds broken. */
const privacy: TextRule = {
  id: "privacy",
  text: "Do not reveal the owner's private records.",
};

/** A structure check that passes every message with `textRules` to judge. */
const passing =
  (textRules: readonly TextRule[], instance?: unknown): StructureCheck =>
  () => ({ kind: "passed", textRules, instance });

/** A provider that answers as `answersTo` does and adds each request to `requests`. */
function answering(
  choices: Readonly<Record<string, string | Answer>> = {},
  requests: DecisionRequest[] = [],
): Answering {
  return {
    answer: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return answersTo(request, choices);
      }),
  };
}

/** Finds `privacy` broken and every other rule followed, with certainty. */
const certain = answering({ [privacy.id]: "violation" });

/** What a test's firewall differs in from that of the server agent Alice, whose norms give every message `privacy` and whose provider is `certain`. */
interface Setup {
  readonly rules?: readonly TextRule[];
  readonly provider?: Answering;
  readonly minimumProbability?: number;
  readonly timeoutMilliseconds?: number;
  readonly earlier?: readonly CheckedMessage[];
  readonly structureCheck?: StructureCheck;
  readonly historyLimit?: number;
}

/** The client Bob's plain message to Alice. */
const fromBob = Message.create({
  author: bob,
  recipient: alice,
  text: "Hello",
});

/** Checks Alice's message to Bob when the server sends, or Bob's message to her when the client does, with her firewall under `setup`. */
function check(sender: Role, setup: Setup = {}) {
  const firewall = firewallOf(setup);
  return Effect.gen(function* () {
    const message =
      sender === "server"
        ? yield* Message.create({
            author: alice,
            recipient: bob,
            text: "The private record says the owner is away.",
          })
        : yield* fromBob;
    return yield* firewall.check(sender, message, setup.earlier ?? []);
  });
}

/** Alice's firewall under `setup`. */
function firewallOf(setup: Setup = {}) {
  return makeFirewall({
    norms: {
      structureCheck: setup.structureCheck ?? passing(setup.rules ?? [privacy]),
    },
    provider: {
      ...(setup.provider ?? certain),
      minimumProbability: setup.minimumProbability ?? 0.5,
      timeoutMilliseconds: setup.timeoutMilliseconds ?? 5_000,
      maximumConcurrentChecks: 4,
    },
    historyLimit: setup.historyLimit,
  });
}

type Choice = "compliant" | "violation";
const choices = fc.constantFrom<Choice>("compliant", "violation");
/** An answer that gives its choice this probability and the other option the rest. */
function answer(choice: Choice, probability: number): Answer {
  const rival = choice === "compliant" ? "violation" : "compliant";
  return {
    choice,
    probabilities: { [choice]: probability, [rival]: 1 - probability },
  };
}
/** A probability from an even split to certainty, in whole percents so that two of them compare exactly. */
const percent = fc.integer({ min: 50, max: 100 }).map((whole) => whole / 100);

it.prop(
  "follows an answer at or above the minimum probability, and takes one below it as unsure: a message with an unsure answer is refused as unsure with the rule's text as feedback, whichever member sent it",
  [fc.constantFrom(...senders), choices, percent, percent],
  ([sender, choice, probability, minimumProbability]) =>
    Effect.gen(function* () {
      const result = yield* check(sender, {
        rules: [proposal],
        provider: answering({ [proposal.id]: answer(choice, probability) }),
        minimumProbability,
      });
      const refused = (reason: string) => ({
        kind: "refused",
        reason,
        feedback: [proposal.text],
      });
      const settled = {
        compliant: { kind: "allowed" },
        violation: refused("violation"),
      }[choice];

      expect(result).toMatchObject(
        probability < minimumProbability ? refused("unsure") : settled,
      );
    }),
);

it("refuses a message as unsure when its choice meets the minimum probability but trails the other option", () =>
  Effect.gen(function* () {
    const result = yield* check("server", {
      rules: [proposal],
      provider: answering({
        [proposal.id]: {
          choice: "compliant",
          probabilities: { compliant: 0.5, violation: 0.51 },
        },
      }),
    });
    expect(result).toMatchObject({
      reason: "unsure",
      feedback: [proposal.text],
    });
  }));

it.prop(
  "refuses a message that violates one rule whether the provider is sure or unsure of another rule, and whichever way it leans",
  [fc.constantFrom(...senders), choices, percent],
  ([sender, choice, probability]) =>
    Effect.gen(function* () {
      const result = yield* check(sender, {
        rules: [privacy, proposal],
        provider: answering({
          [privacy.id]: "violation",
          [proposal.id]: answer(choice, probability),
        }),
        minimumProbability: 0.8,
      });
      expect(result).toMatchObject({
        kind: "refused",
        reason: "violation",
      });
    }),
);

it.each(senders)(
  "refuses a message the %s sends that breaks a rule, with the rule's text as feedback and a record that names the sender and the conversation's client",
  (sender) =>
    Effect.gen(function* () {
      expect(yield* check(sender)).toMatchObject({
        kind: "refused",
        reason: "violation",
        feedback: [privacy.text],
        record: {
          sender,
          client: bob,
          decision: "refused",
          reason: "violation",
          refusedBy: [{ ruleId: privacy.id, feedback: privacy.text }],
          checkedRuleIds: [privacy.id],
        },
      });
    }),
);

it.each([
  {
    failure: "fails",
    provider: {
      answer: () =>
        Effect.fail(new DecisionProviderError({ transient: false })),
    },
  },
  {
    failure: "leaves a question unanswered",
    provider: { answer: () => Effect.succeed({ answers: {} }) },
  },
  {
    failure: "chooses an answer the question does not offer",
    provider: answering({ [privacy.id]: "allow-everything" }),
  },
] satisfies ReadonlyArray<{ failure: string; provider: Answering }>)(
  "refuses a message of either member as an unavailable check, with no feedback and nothing to save, when the provider $failure",
  ({ provider }) =>
    Effect.gen(function* () {
      for (const sender of senders) {
        const result = yield* check(sender, { provider });
        expect(result).toMatchObject({
          kind: "refused",
          reason: "unavailable",
          feedback: [],
        });
        expect(result).not.toHaveProperty("record");
      }
    }),
);

it.each(senders)(
  "asks the provider once about exactly the rules a message the %s sends is given, stating each rule's text and which member sent it",
  (sender) =>
    Effect.gen(function* () {
      const rules = [proposal, privacy];
      const requests: DecisionRequest[] = [];
      const result = yield* check(sender, {
        rules,
        provider: answering({}, requests),
      });
      const [request, ...others] = requests;
      const state = Schema.decodeUnknownSync(
        Schema.parseJson(
          Schema.Struct({
            sender: Schema.String,
            rules: Schema.Array(Schema.Unknown),
          }),
        ),
      )(request?.state);

      expect(others).toEqual([]);
      expect(result).toMatchObject({
        kind: "allowed",
        record: { checkedRuleIds: [proposal.id, privacy.id] },
      });
      expect(
        Object.values(request?.questions ?? {}).map(({ ruleId }) => ruleId),
      ).toEqual([proposal.id, privacy.id]);
      expect(state).toEqual({ sender, rules });
    }),
);

it("makes the check of a message that has rules unavailable when the server names no decision provider", () =>
  Effect.gen(function* () {
    const firewall = makeFirewall({
      norms: { structureCheck: passing([privacy]) },
    });

    expect(yield* firewall.check("client", yield* fromBob, [])).toMatchObject({
      kind: "refused",
      reason: "unavailable",
    });
  }));

it("shows the provider only the latest earlier messages that fit its byte limit, says it left earlier ones out, and still decides", () =>
  Effect.gen(function* () {
    const requests: DecisionRequest[] = [];
    const large = {
      message: yield* Message.create({
        author: bob,
        recipient: alice,
        text: "x".repeat(32_000),
      }),
      sender: "client" as const,
      checkedAt: 1,
    };

    const result = yield* check("client", {
      rules: [proposal],
      provider: answering({}, requests),
      earlier: Array.from({ length: 80 }, () => large),
    });

    const [shown] = requests.map(({ state }) =>
      Schema.decodeUnknownSync(
        Schema.parseJson(
          Schema.Struct({
            history: Schema.Array(Schema.Unknown),
            earlierHistoryOmitted: Schema.Boolean,
          }),
        ),
      )(state),
    );
    expect(result.kind).toBe("allowed");
    expect(shown?.history.length).toBeGreaterThan(0);
    expect(shown?.history.length).toBeLessThan(80);
    expect(shown?.earlierHistoryOmitted).toBe(true);
  }));

it.prop(
  "makes the check unavailable exactly when the provider answers after the request deadline",
  [
    fc
      .tuple(fc.integer({ min: 1, max: 1000 }), fc.nat({ max: 1000 }))
      .filter(([perRequest, delay]) => delay !== perRequest),
  ],
  ([[timeoutMilliseconds, delay]]) =>
    Effect.gen(function* () {
      const running = yield* check("server", {
        rules: [proposal],
        provider: {
          answer: (request) =>
            Effect.sleep(delay).pipe(Effect.as(answersTo(request))),
        },
        timeoutMilliseconds,
      }).pipe(Effect.fork);
      yield* TestClock.adjust(delay);
      const result = yield* Fiber.join(running);
      expect(result).toMatchObject(
        delay < timeoutMilliseconds
          ? { kind: "allowed" }
          : { reason: "unavailable" },
      );
    }),
);

it("allows every message on a server without norms, with nothing to save", () =>
  Effect.gen(function* () {
    const firewall = makeFirewall({});
    const message = yield* fromBob;

    for (const sender of senders) {
      expect(yield* firewall.check(sender, message, [])).toEqual({
        kind: "allowed",
      });
    }
  }));

it.prop(
  "shows the provider the latest earlier messages up to its history limit, and says when it left earlier ones out",
  [fc.integer({ min: 1, max: 4 }), fc.nat({ max: 6 })],
  ([historyLimit, sent]) =>
    Effect.gen(function* () {
      const requests: DecisionRequest[] = [];
      const message = yield* fromBob;

      yield* check("client", {
        provider: answering({}, requests),
        historyLimit,
        earlier: Array.from({ length: sent }, () => ({
          message,
          sender: "client" as const,
          checkedAt: 1,
        })),
      });

      const [shown] = requests.map(({ state }) =>
        Schema.decodeUnknownSync(
          Schema.parseJson(
            Schema.Struct({
              history: Schema.Array(Schema.Unknown),
              earlierHistoryOmitted: Schema.Boolean,
            }),
          ),
        )(state),
      );
      expect(shown?.history).toHaveLength(Math.min(sent, historyLimit));
      expect(shown?.earlierHistoryOmitted).toBe(sent > historyLimit);
    }),
  { fastCheck: { numRuns: 20 } },
);

describe("Firewall structure check", () => {
  const refusal = {
    kind: "refused",
    ruleId: "shape",
    feedback: "Send a greeting first.",
  } as const;

  it.each(senders)(
    "refuses a message the %s sends that its structure check refuses, under that check's rule and without asking the provider",
    (sender) =>
      Effect.gen(function* () {
        const result = yield* check(sender, {
          provider: { answer: () => Effect.dieMessage("Provider asked") },
          structureCheck: () => refusal,
        });

        expect(result).toMatchObject({
          kind: "refused",
          reason: "violation",
          feedback: [refusal.feedback],
          record: {
            refusedBy: [{ ruleId: "shape" }],
            checkedRuleIds: ["shape"],
          },
        });
      }),
  );

  it("asks the provider about a message its structure check passes by that check's rules, shows the provider the instance that check gives, and tells the check which member sent each message and when it was checked", () =>
    Effect.gen(function* () {
      const requests: DecisionRequest[] = [];
      const checked: Array<Parameters<StructureCheck>> = [];
      const earlier = [
        { message: yield* fromBob, sender: "client" as const, checkedAt: 1 },
        {
          message: yield* Message.create({
            author: alice,
            recipient: bob,
            text: "Hi",
          }),
          sender: "server" as const,
        },
      ];

      const result = yield* check("client", {
        provider: answering({ [privacy.id]: "violation" }, requests),
        earlier,
        structureCheck: (...given) => {
          checked.push(given);
          return passing([privacy], { turn: 2 })(...given);
        },
      });

      expect(checked).toMatchObject([
        [
          { sender: "client", text: "Hello" },
          [
            { sender: "client", text: "Hello", checkedAt: 1 },
            { sender: "server", text: "Hi" },
          ],
          0,
        ],
      ]);
      expect(
        requests.map(({ state, questions }) => [
          Schema.decodeUnknownSync(
            Schema.parseJson(Schema.Struct({ instance: Schema.Unknown })),
          )(state).instance,
          Object.values(questions).map(({ ruleId }) => ruleId),
        ]),
      ).toEqual([[{ turn: 2 }, [privacy.id]]]);
      expect(result).toMatchObject({
        kind: "refused",
        feedback: [privacy.text],
      });
    }));
});

const secret = "unit-test-credential";
const model = "jev-1.13.0";
const jevAnswer = JSON.stringify({
  model: "jev-1.13.0",
  answers: {
    q0: {
      type: "choice",
      choice: "compliant",
      probabilities: { compliant: 0.8, violation: 0.2 },
      confidence: 0.43,
    },
  },
  usage: { input_tokens: 123, output_tokens: 12 },
});

/**
 * Checks Bob's message against `privacy` with Jev as the provider and
 * `respond` in place of the network. Gives the check's result and the
 * requests Jev was sent.
 */
function checkWithJev(respond: () => ReturnType<typeof globalThis.fetch>) {
  const requests: Array<{
    readonly url: string;
    readonly init?: RequestInit;
  }> = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    requests.push({
      url: input instanceof Request ? input.url : new URL(input).href,
      ...(init ? { init } : {}),
    });
    return respond();
  };
  return Effect.gen(function* () {
    const result = yield* check("client", {
      provider: jevDecisionProvider(Redacted.make(secret), {
        model,
        minimumProbability: 0.8,
        timeoutMilliseconds: 15_000,
        maximumConcurrentChecks: 4,
      }),
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
    return { result, requests };
  });
}

describe("Jev", () => {
  live(
    "asks Jev one choice question per rule under its model and key, and follows its answer",
    () =>
      Effect.gen(function* () {
        const { result, requests } = yield* checkWithJev(() =>
          Promise.resolve(new Response(jevAnswer)),
        );
        const [request] = requests;
        const sent = request?.init?.body;
        const body = Schema.decodeUnknownSync(
          Schema.parseJson(
            Schema.Struct({
              model: Schema.String,
              state: Schema.String,
              questions: Schema.Record({
                key: Schema.String,
                value: Schema.Struct({ type: Schema.String }),
              }),
            }),
          ),
        )(sent instanceof Uint8Array ? new TextDecoder().decode(sent) : "");

        expect(requests).toHaveLength(1);
        expect(request?.url).toBe("https://api.typesafe.ai/v1/systemone");
        expect(new Headers(request?.init?.headers).get("authorization")).toBe(
          `Bearer ${secret}`,
        );
        expect(body.model).toBe(model);
        expect(body.state).toContain(privacy.text);
        expect(Object.values(body.questions)).toEqual([{ type: "choice" }]);
        expect(result.kind).toBe("allowed");
      }),
  );

  const rejected = (status: number) => () =>
    Promise.resolve(new Response(`Rejected Bearer ${secret}`, { status }));
  const answered = (body: string) => () => Promise.resolve(new Response(body));

  live.each([
    { failure: "answers a client error", respond: rejected(400), sent: 1 },
    { failure: "answers a rate limit", respond: rejected(429), sent: 3 },
    { failure: "answers a server failure", respond: rejected(503), sent: 3 },
    {
      failure: "cannot be reached",
      respond: () => Promise.reject(new Error(`No route with ${secret}`)),
      sent: 3,
    },
    {
      failure: "answers text that is not JSON",
      respond: answered("no"),
      sent: 1,
    },
    {
      failure: "answers something that is not a choice",
      respond: answered('{"answers":{"q0":{"type":"noul","noul":1}}}'),
      sent: 1,
    },
    {
      failure: "answers a body over the size limit",
      respond: answered("x".repeat(1_048_577)),
      sent: 1,
    },
  ])(
    "makes the check unavailable when Jev $failure, after $sent request(s) and without the credential",
    ({ respond, sent }) =>
      Effect.gen(function* () {
        const { result, requests } = yield* checkWithJev(respond);

        expect(result).toMatchObject({ reason: "unavailable" });
        expect(requests).toHaveLength(sent);
        expect(JSON.stringify(result)).not.toContain(secret);
      }),
  );
});
