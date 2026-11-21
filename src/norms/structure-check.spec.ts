/** @file The structure check passes exactly the acts a norm's turn rules and forms allow after a conversation's earlier messages and the firewall's checks of them, and names what is wrong with any other message. */

import { Effect, Either, FastCheck as fc, Option, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import type { CheckedMessage } from "../firewall.js";
import { AgentName, Message, MsgId } from "../messages.js";
import { compileNorm } from "./compiler.js";
import { readAct } from "./lisp.js";
import { structureCheck } from "./structure-check.js";

/** The client of every conversation here. */
const alice = AgentName.make("alice");
/** The server agent. */
const bob = AgentName.make("bob");
const agents = [alice, bob] as const;

/** The norm a document declares. */
const normFrom = (document: string) => Either.getOrThrow(compileNorm(document));
type Norm = ReturnType<typeof normFrom>;

/** The text of an act: its performative, its norm and each field, with strings quoted and a selection as a list. */
function actText(
  name: string,
  norm: string,
  fields: Readonly<Record<string, string | number | readonly string[]>> = {},
) {
  const stated = Object.entries(fields).map(
    ([field, value]) =>
      ` :${field} ${
        typeof value === "object"
          ? `(${value.map((choice) => JSON.stringify(choice)).join(" ")})`
          : JSON.stringify(value)
      }`,
  );
  return `(${name} :norm ${norm}${stated.join("")})`;
}

/**
 * Offers alternate. Either member's `offer` opens an instance. Only the
 * recipient of the current offer may `counter` it or `choose` its value,
 * replying in its chain, and choosing settles it. Either member may `finish`.
 */
const turns = normFrom(`
(norm turns)
(act offer :by (client server) :starts true :initiates offered
  (field value :type string))
(act counter :by (recipient (fact offered)) :when offered :initiates offered
  (field value :type string))
(act choose :by (recipient (fact offered)) :when offered
  :terminates offered :initiates selected
  (field value :type string)
  (relation equals value (previous (fact offered) value)))
(act finish :by (client server) :ends true)
`);

/** A message id no generated history holds. */
const unknownId = Schema.decodeUnknownSync(MsgId)(`msg_${"A".repeat(43)}`);

/**
 * Checks the act `text` from `author` against `history` at `now`, and adds
 * its message to the history when the check passes it, as a refused message
 * is not stored. A history that holds every message twice gives the same
 * answer.
 */
function attempt(
  norm: Norm,
  history: CheckedMessage[],
  taken: {
    readonly author: AgentName;
    readonly text: string;
    readonly now: number;
    readonly reply: Option.Option<MsgId>;
  },
) {
  const candidate = message(
    taken.author,
    taken.text,
    { replyToMsgId: Option.getOrUndefined(taken.reply) },
    stepId(history.length),
  );
  const { kind } = check(norm, candidate, history, taken.now);
  if (kind === "passed") {
    history.push({ message: candidate, checkedAt: taken.now });
  }
  return kind === "passed";
}

/** A message of `text` from `author` to the other agent, under `msgId` or a new id. */
function message(
  author: AgentName,
  text: string,
  reference: Pick<Message, "replyToMsgId"> = {},
  msgId?: MsgId,
): Message {
  return Schema.decodeSync(Message)({
    author,
    recipient: author === alice ? bob : alice,
    msgId: msgId ?? `msg_${randomBytes(32).toString("base64url")}`,
    ...reference,
    text,
  });
}

/** What the structure check of a server that holds `norm` says of `candidate` at `now`, after `history`. */
function check(
  norm: Norm,
  candidate: Message,
  history: readonly CheckedMessage[] = [],
  now = 0,
) {
  return Effect.runSync(
    structureCheck([norm], readAct)(
      candidate.author === alice ? "client" : "server",
      candidate,
      history,
      now,
    ),
  );
}

/** The message id of step `index` of a walk. */
function stepId(index: number): MsgId {
  return Schema.decodeUnknownSync(MsgId)(
    `msg_${Buffer.alloc(32, index + 1).toString("base64url")}`,
  );
}

/**
 * One step of a walk: who sends which act with which value, and the message
 * it replies to. Counters and replies to earlier steps are the likeliest, so
 * walks reach offers several messages deep.
 */
const step = fc.record({
  author: fc.constantFrom(0, 1),
  act: fc.oneof(
    { weight: 2, arbitrary: fc.constant("offer") },
    { weight: 5, arbitrary: fc.constant("counter") },
    { weight: 2, arbitrary: fc.constant("choose") },
    { weight: 1, arbitrary: fc.constant("finish") },
  ),
  value: fc.constantFrom("a", "b"),
  reply: fc.oneof(
    { weight: 2, arbitrary: fc.constant<"none" | "unknown">("none") },
    { weight: 1, arbitrary: fc.constant<"none" | "unknown">("unknown") },
    { weight: 7, arbitrary: fc.nat({ max: 11 }) },
  ),
});

type Step =
  typeof step extends fc.Arbitrary<infer Generated> ? Generated : never;

/**
 * What the `turns` norm's turn rules say of a walk, kept apart from the
 * code under test: whether an instance is open, the current offer, and each
 * message of the instance with the message it replied to.
 */
interface Model {
  open: boolean;
  offer?: {
    readonly id: MsgId;
    readonly author: number;
    readonly value: string;
  };
  readonly members: Map<MsgId, Option.Option<MsgId>>;
  readonly known: Set<MsgId>;
}

/** The message a step replies to: none, one no history holds, or an earlier step's. */
function replyOf(
  history: readonly CheckedMessage[],
  taken: Step,
): Option.Option<MsgId> {
  if (taken.reply === "none") {
    return Option.none();
  }
  if (taken.reply === "unknown") {
    return Option.some(unknownId);
  }
  return Option.fromNullable(
    history[taken.reply % Math.max(history.length, 1)]?.message.msgId,
  );
}

/** Whether the model's rules permit `taken` as a reply to `reply`. */
function modelPermits(
  model: Model,
  taken: Step,
  reply: Option.Option<MsgId>,
): boolean {
  if (!model.open) {
    return (
      taken.act === "offer" &&
      Option.match(reply, {
        onNone: () => true,
        onSome: (id) => model.known.has(id),
      })
    );
  }
  const inInstance = Option.filter(reply, (id) => model.members.has(id));
  if (taken.act === "offer" || Option.isNone(inInstance)) {
    return false;
  }
  return taken.act === "finish" || answersOffer(model, taken, inInstance.value);
}

/** Whether `taken` counters or chooses the current offer: from its recipient, in a reply chain that holds it. */
function answersOffer(model: Model, taken: Step, reply: MsgId): boolean {
  const chain = new Set<MsgId>();
  let current = Option.some(reply);
  while (
    Option.isSome(current) &&
    model.members.has(current.value) &&
    !chain.has(current.value)
  ) {
    chain.add(current.value);
    current = model.members.get(current.value) ?? Option.none();
  }
  const offer = model.offer;
  if (
    offer === undefined ||
    !chain.has(offer.id) ||
    offer.author === taken.author
  ) {
    return false;
  }
  return taken.act === "counter" || taken.value === offer.value;
}

/** Applies a permitted step to the model: its message joins the instance, and its act takes effect. */
function advanceModel(
  model: Model,
  taken: Step,
  message: { readonly id: MsgId; readonly reply: Option.Option<MsgId> },
) {
  const { id, reply } = message;
  model.members.set(id, reply);
  model.known.add(id);
  switch (taken.act) {
    case "finish":
      model.open = false;
      delete model.offer;
      model.members.clear();
      break;
    case "choose":
      delete model.offer;
      break;
    default:
      model.open = true;
      model.offer = { id, author: taken.author, value: taken.value };
  }
}

it("permits exactly the acts the turn rules allow, whoever sends them and whichever message they reply to", () => {
  fc.assert(
    fc.property(fc.array(step, { maxLength: 12 }), (steps) => {
      const history: CheckedMessage[] = [];
      const model: Model = {
        open: false,
        members: new Map(),
        known: new Set(),
      };
      for (const taken of steps) {
        const id = stepId(history.length);
        const reply = replyOf(history, taken);
        const expected = modelPermits(model, taken, reply);
        const permitted = attempt(turns, history, {
          author: agents[taken.author] ?? alice,
          text: actText(
            taken.act,
            "turns",
            taken.act === "finish" ? {} : { value: taken.value },
          ),
          now: 0,
          reply,
        });
        expect(permitted).toBe(expected);
        if (permitted) {
          advanceModel(model, taken, { id, reply });
        }
      }
    }),
    { numRuns: 500 },
  );
});

it("permits an act with a delay and a limit only once its fact is that old and while it was sent fewer times than the limit", () => {
  fc.assert(
    fc.property(
      fc.record({
        wait: fc.nat({ max: 50 }),
        elapsed: fc.nat({ max: 60_000 }),
        maximum: fc.integer({ min: 1, max: 3 }),
        sent: fc.nat({ max: 4 }),
      }),
      ({ wait, elapsed, maximum, sent }) => {
        const timed = normFrom(`
(norm timed)
(act hold :by client :starts true :initiates held
  (field wait :type integer :minimum 0))
(act poll :by (client server) :when held :max ${maximum}
  :after held :delay wait :unit seconds)
`);
        const history: CheckedMessage[] = [];
        const start = 1_000;
        const due = start + wait * 1000;
        attempt(timed, history, {
          author: alice,
          text: actText("hold", "timed", { wait }),
          now: start,
          reply: Option.none(),
        });
        const poll = (now: number) =>
          attempt(timed, history, {
            author: bob,
            text: actText("poll", "timed"),
            now,
            reply: Option.some(stepId(0)),
          });
        for (let count = 0; count < sent; count += 1) {
          expect(poll(due)).toBe(count < maximum);
        }
        expect(poll(start + elapsed)).toBe(
          start + elapsed >= due && sent < maximum,
        );
      },
    ),
  );
});

/** The client's `open` starts an instance and the server's `close` ends it. */
const exchange = normFrom(`
(norm exchange)
(act open :by client :starts true :initiates opened
  (field value :type string))
(act close :by server :when opened :ends true)
`);

it("refuses every text that is not an act of a held norm", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), (text) => {
      expect(check(exchange, message(alice, text))).toMatchObject({
        kind: "refused",
        reason: "rule-violation",
        ruleId: "norm-structural",
      });
    }),
    { numRuns: 60 },
  );
});

it("passes an act with one text rule for each described string or list field it states, which holds the field to its description", () => {
  const described = normFrom(`
(norm described)
(act ask :by client :starts true :ends true
  (field topic :type string :description "The subject.")
  (field slots :type list :description "One slot.")
  (field note :type string :optional true :description "A short note.")
  (field plain :type string :optional true)
  (field count :type integer :optional true :description "How many."))
`);
  const ask = actText("ask", "described", {
    topic: "x",
    slots: ["mon"],
    plain: "y",
    count: 2,
  });

  expect(check(described, message(alice, ask))).toMatchObject({
    kind: "passed",
    textRules: [
      {
        id: "described.ask.topic",
        text: "topic must hold what its description says and nothing else: The subject.",
      },
      {
        id: "described.ask.slots",
        text: "each item of slots must hold what its description says and nothing else: One slot.",
      },
    ],
    protocol: { norm: "described", act: "ask" },
  });
});

it("refuses an act from the member whose role may not send it, to open an instance and within one", () => {
  const open = message(alice, actText("open", "exchange", { value: "x" }));

  expect(
    check(exchange, message(bob, actText("open", "exchange", { value: "x" }))),
  ).toMatchObject({ kind: "refused", ruleId: "exchange-protocol" });
  expect(
    check(
      exchange,
      message(alice, actText("close", "exchange"), {
        replyToMsgId: open.msgId,
      }),
      [{ message: open, checkedAt: 1 }],
    ),
  ).toMatchObject({ kind: "refused", ruleId: "exchange-protocol" });
});

it.each([
  { checked: { checkedAt: 1 }, continues: "passed" },
  { checked: {}, continues: "refused" },
])(
  "continues an instance only from an opening act the firewall checked: $checked",
  ({ checked, continues }) => {
    const open = message(alice, actText("open", "exchange", { value: "x" }));

    const result = check(
      exchange,
      message(bob, actText("close", "exchange"), { replyToMsgId: open.msgId }),
      [{ message: open, ...checked }],
    );

    expect(result.kind).toBe(continues);
  },
);

it.each([
  { what: "plain text", text: "hello", stage: "structural" },
  {
    what: "an act the norm lacks",
    text: "(unknown :norm exchange)",
    stage: "structural",
  },
  {
    what: "a field its form lacks",
    text: '(close :norm exchange :extra "unasked")',
    stage: "structural",
  },
  {
    what: "a comment after the act",
    text: "(close :norm exchange) ; note",
    stage: "structural",
  },
  {
    what: "an unclosed act",
    text: "(close :norm exchange",
    stage: "structural",
  },
  {
    what: "a second opening",
    text: '(open :norm exchange :value "again")',
    stage: "protocol",
  },
  {
    what: "an act of another norm",
    text: "(close :norm other)",
    stage: "protocol",
  },
])(
  "refuses $what in an instance under the norm's $stage rule",
  ({ text, stage }) => {
    const open = message(alice, actText("open", "exchange", { value: "x" }));

    const result = check(
      exchange,
      message(bob, text, { replyToMsgId: open.msgId }),
      [{ message: open, checkedAt: 1 }],
    );

    expect(result).toMatchObject({
      kind: "refused",
      ruleId: `exchange-${stage}`,
    });
  },
);

/** A norm whose one act, `open`, has the declared fields. */
const sampleOf = (fields: readonly string[]) =>
  normFrom(`
(norm sample)
(act open :by client :starts true :ends true
  ${fields.join("\n  ")})
`);

/** Whether a field declared as `declaration` accepts the value an act states as `value`. */
const accepted = (
  declaration: string,
  value: string | number | readonly string[],
) =>
  check(
    sampleOf([`(field field ${declaration})`]),
    message(alice, actText("open", "sample", { field: value })),
  ).kind === "passed";

it("names exactly the fields an act is missing, adds or gets wrong", () => {
  const names = ["slot", "hours", "note", "constructor", "prototype"];
  const field = fc.record({
    declared: fc.boolean(),
    required: fc.boolean(),
    stated: fc.constantFrom("absent", "valid", "invalid"),
  });
  fc.assert(
    fc.property(fc.tuple(field, field, field, field, field), (fields) => {
      const named = fields.map((state, index) => ({
        ...state,
        name: names[index] ?? "",
      }));
      const result = check(
        sampleOf(
          named
            .filter((state) => state.declared)
            .map(
              (state) =>
                `(field ${state.name} :type string :max-length 3${state.required ? "" : " :optional true"})`,
            ),
        ),
        message(
          alice,
          actText(
            "open",
            "sample",
            Object.fromEntries(
              named
                .filter((state) => state.stated !== "absent")
                .map((state) => [
                  state.name,
                  state.stated === "valid" ? "yes" : "never",
                ]),
            ),
          ),
        ),
      );
      const failureOf = (state: (typeof named)[number]) => {
        if (!state.declared) {
          return state.stated === "absent" ? [] : ["is not a valid field of"];
        }
        if (state.stated === "absent") {
          return state.required ? ["is required for"] : [];
        }
        return state.stated === "valid" ? [] : ["is not valid for"];
      };
      const expected = named.flatMap((state) =>
        failureOf(state).map(
          (failure) => `${state.name} ${failure} open in sample.`,
        ),
      );
      const stated =
        result.kind === "refused" ? result.feedback.split(/(?<=\.) /u) : [];
      expect(new Set(stated)).toEqual(new Set(expected));
      expect(stated).toHaveLength(expected.length);
    }),
  );
});

it("refuses a value another type of field is given", () => {
  const kinds = [
    { declaration: ":type string", value: "a" },
    { declaration: ":type integer", value: 1 },
    { declaration: ":type list", value: ["a"] },
  ];
  for (const asked of kinds) {
    for (const given of kinds) {
      expect(accepted(asked.declaration, given.value)).toBe(asked === given);
    }
  }
});

it("holds an integer to its bounds and to whole values", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -100, max: 100 }),
      fc.integer({ min: 0, max: 50 }),
      fc.oneof(
        fc.integer({ min: -200, max: 200 }),
        fc.double({ min: -200, max: 200, noNaN: true }),
      ),
      (minimum, span, value) => {
        const maximum = minimum + span;
        expect(
          accepted(
            `:type integer :minimum ${minimum} :maximum ${maximum}`,
            value,
          ),
        ).toBe(Number.isInteger(value) && value >= minimum && value <= maximum);
      },
    ),
  );
});

it("reads any quoted string and counts its length in code points against its bounds", () => {
  fc.assert(
    fc.property(
      fc.string({ unit: "grapheme", maxLength: 8 }),
      fc.integer({ min: 0, max: 4 }),
      fc.integer({ min: 0, max: 4 }),
      (text, minLength, span) => {
        const maxLength = minLength + span;
        const length = Array.from(text).length;
        expect(
          accepted(
            `:type string :min-length ${minLength} :max-length ${maxLength}`,
            text,
          ),
        ).toBe(length >= minLength && length <= maxLength);
      },
    ),
  );
});

it("holds a list to nonempty items and their count to its bounds", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("a", "b", ""), { maxLength: 5 }),
      fc.integer({ min: 0, max: 3 }),
      fc.integer({ min: 0, max: 3 }),
      (items, minItems, span) => {
        const maxItems = minItems + span;
        expect(
          accepted(
            `:type list :min-items ${minItems} :max-items ${maxItems}`,
            items,
          ),
        ).toBe(
          items.length >= minItems &&
            items.length <= maxItems &&
            !items.includes(""),
        );
      },
    ),
  );
});

/** The client offers slots, the server keeps some of them, and the client picks one of those kept. */
const picking = normFrom(`
(norm picking)
(act offer :by client :starts true :initiates offered
  (field slots :type list :min-items 1))
(act keep :by server :when offered :initiates kept
  (field slots :type list :min-items 1)
  (relation subset slots (previous offer slots)))
(act pick :by client :when kept :ends true
  (field slot :type string)
  (relation member slot (previous (fact kept) slots)))
`);

it("holds a list to a subset of an earlier list, and a string to one of an earlier list's items", () => {
  const item = fc.constantFrom("mon", "tue", "wed");
  fc.assert(
    fc.property(
      fc.array(item, { minLength: 1, maxLength: 3 }),
      fc.array(item, { minLength: 1, maxLength: 3 }),
      item,
      (offered, kept, picked) => {
        const history: CheckedMessage[] = [];
        const send = (author: AgentName, text: string) =>
          attempt(picking, history, {
            author,
            text,
            now: 1,
            reply: Option.fromNullable(history.at(-1)?.message.msgId),
          });

        send(alice, actText("offer", "picking", { slots: offered }));
        const within = kept.every((slot) => offered.includes(slot));
        expect(send(bob, actText("keep", "picking", { slots: kept }))).toBe(
          within,
        );
        expect(send(alice, actText("pick", "picking", { slot: picked }))).toBe(
          within && kept.includes(picked),
        );
      },
    ),
  );
});
