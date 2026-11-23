/** @file The structure check passes exactly the acts a norm's turn rules and forms allow after a conversation's earlier messages and the firewall's checks of them, and names what is wrong with any other message. */

import { Either, FastCheck as fc, Option } from "effect";
import { expect, it } from "vitest";
import type { FieldValue, Role } from "./norm.js";
import { compileNorm } from "./compiler.js";
import { readAct } from "./lisp.js";
import { type Sent, structureCheck } from "./structure-check.js";

const client: Role = "client";
const server: Role = "server";
const members = [client, server] as const;

/** The norm a document declares. */
const normFrom = (document: string) => Either.getOrThrow(compileNorm(document));
type Norm = ReturnType<typeof normFrom>;

/** The text of an act: its performative, its norm and each field, with strings quoted and a selection as a list. */
function actText(
  name: string,
  norm: string,
  fields: Readonly<Record<string, FieldValue>> = {},
) {
  const stated = Object.entries(fields).map(
    ([field, value]) => ` :${field} ${valueText(value)}`,
  );
  return `(${name} :norm ${norm}${stated.join("")})`;
}

/** A value as an act writes it: text quoted, and a list or a record in parentheses. */
function valueText(value: FieldValue): string {
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  const parts =
    value instanceof Array
      ? value.map((item: FieldValue) => valueText(item))
      : Object.entries(value).map(
          ([field, item]) => `:${field} ${valueText(item)}`,
        );
  return `(${parts.join(" ")})`;
}

/**
 * Offers alternate. Either member's `offer` starts an instance. Only the
 * recipient of the current offer may `counter` it or `choose` its value,
 * replying in its chain, and choosing settles it. Either member may `finish`.
 */
const turns = normFrom(`
(norm turns)
(act offer :by (client server) :starts true :sets offered
  (field value :type string))
(act counter :by (recipient (fact offered)) :when offered :sets offered
  (field value :type string))
(act choose :by (recipient (fact offered)) :when offered
  :clears offered :sets selected
  (field value :type string)
  (relation equals value (previous (fact offered) value)))
(act finish :by (client server) :ends true)
`);

/** A message id no generated history contains. */
const unknownId = "unknown";

/**
 * Checks the act `text` from `author` against `history` at `now`, and adds
 * its message to the history when the check passes it, as a refused message
 * is not stored. A history that contains every message twice gives the same
 * answer.
 */
function attempt(
  norm: Norm,
  history: Sent[],
  taken: {
    readonly author: Role;
    readonly text: string;
    readonly now: number;
    readonly reply: Option.Option<string>;
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
    history.push({ ...candidate, checkedAt: taken.now });
  }
  return kind === "passed";
}

let minted = 0;

/** A message of `text` from `author`, under `msgId` or a new id. */
function message(
  author: Role,
  text: string,
  reference: Pick<Sent, "replyToMsgId"> = {},
  msgId?: string,
): Sent {
  minted += 1;
  return {
    msgId: msgId ?? `minted-${minted}`,
    ...reference,
    sender: author,
    text,
  };
}

/** What the structure check of a server that publishes `norm` finds of `candidate` at `now`, after `history`. */
function check(
  norm: Norm,
  candidate: Sent,
  history: readonly Sent[] = [],
  now = 0,
) {
  return structureCheck([norm], readAct)(candidate, history, now);
}

/** The message id of step `index` of a walk. */
function stepId(index: number): string {
  return `step-${index}`;
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
    readonly id: string;
    readonly author: number;
    readonly value: string;
  };
  readonly members: Map<string, Option.Option<string>>;
  readonly known: Set<string>;
}

/** The message a step replies to: none, one no history contains, or an earlier step's. */
function replyOf(history: readonly Sent[], taken: Step): Option.Option<string> {
  if (taken.reply === "none") {
    return Option.none();
  }
  if (taken.reply === "unknown") {
    return Option.some(unknownId);
  }
  return Option.fromNullable(
    history[taken.reply % Math.max(history.length, 1)]?.msgId,
  );
}

/** Whether the model's rules permit `taken` as a reply to `reply`. */
function modelPermits(
  model: Model,
  taken: Step,
  reply: Option.Option<string>,
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

/** Whether `taken` counters or chooses the current offer: from its recipient, in a reply chain that contains it. */
function answersOffer(model: Model, taken: Step, reply: string): boolean {
  const chain = new Set<string>();
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
  message: { readonly id: string; readonly reply: Option.Option<string> },
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
      const history: Sent[] = [];
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
          author: members[taken.author] ?? client,
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
(act hold :by client :starts true :sets held
  (field wait :type integer :minimum 0))
(act poll :by (client server) :when held :max ${maximum}
  :after (held wait))
`);
        const history: Sent[] = [];
        const start = 1_000;
        const due = start + wait * 1000;
        attempt(timed, history, {
          author: client,
          text: actText("hold", "timed", { wait }),
          now: start,
          reply: Option.none(),
        });
        const poll = (now: number) =>
          attempt(timed, history, {
            author: server,
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
(act open :by client :starts true :sets opened
  (field value :type string))
(act close :by server :when opened :ends true)
`);

it("refuses every text that is not an act of one of the server's norms", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), (text) => {
      expect(check(exchange, message(client, text))).toMatchObject({
        kind: "refused",
        ruleId: "norm-form",
      });
    }),
    { numRuns: 60 },
  );
});

it("passes an act with one text rule for each described string or list field it states, which requires the field to contain only what its description says", () => {
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

  expect(check(described, message(client, ask))).toMatchObject({
    kind: "passed",
    textRules: [
      {
        id: "described.ask.topic",
        text: "topic must contain only what its description says: The subject.",
      },
      {
        id: "described.ask.slots",
        text: "each item of slots must contain only what its description says: One slot.",
      },
    ],
    instance: { norm: "described", performative: "ask" },
  });
});

it("refuses an act from the member whose role may not send it, to start an instance and within one", () => {
  const open = message(client, actText("open", "exchange", { value: "x" }));

  expect(
    check(
      exchange,
      message(server, actText("open", "exchange", { value: "x" })),
    ),
  ).toMatchObject({ kind: "refused", ruleId: "exchange-protocol" });
  expect(
    check(
      exchange,
      message(client, actText("close", "exchange"), {
        replyToMsgId: open.msgId,
      }),
      [{ ...open, checkedAt: 1 }],
    ),
  ).toMatchObject({ kind: "refused", ruleId: "exchange-protocol" });
});

it.each([
  { checked: { checkedAt: 1 }, continues: "passed" },
  { checked: {}, continues: "refused" },
])(
  "continues an instance only from a starting act the firewall checked: $checked",
  ({ checked, continues }) => {
    const open = message(client, actText("open", "exchange", { value: "x" }));

    const result = check(
      exchange,
      message(server, actText("close", "exchange"), {
        replyToMsgId: open.msgId,
      }),
      [{ ...open, ...checked }],
    );

    expect(result.kind).toBe(continues);
  },
);

it.each([
  { what: "plain text", text: "hello", stage: "form" },
  {
    what: "an act the norm lacks",
    text: "(unknown :norm exchange)",
    stage: "form",
  },
  {
    what: "a field its form lacks",
    text: '(close :norm exchange :extra "unasked")',
    stage: "form",
  },
  {
    what: "a comment after the act",
    text: "(close :norm exchange) ; note",
    stage: "form",
  },
  {
    what: "an unclosed act",
    text: "(close :norm exchange",
    stage: "form",
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
    const open = message(client, actText("open", "exchange", { value: "x" }));

    const result = check(
      exchange,
      message(server, text, { replyToMsgId: open.msgId }),
      [{ ...open, checkedAt: 1 }],
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
const accepted = (declaration: string, value: FieldValue) =>
  check(
    sampleOf([`(field field ${declaration})`]),
    message(client, actText("open", "sample", { field: value })),
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
          client,
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

it("requires an integer within its bounds and whole", () => {
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

it.each([
  ["date", "2026-11-23", ["2026-02-30", "2026-11-3", "23-11-2026"]],
  ["time", "10:00:00Z", ["10:00", "24:00:00Z", "10:00:00"]],
  [
    "date-time",
    "2026-11-23T10:00:00+01:00",
    ["2026-11-23 10:00:00Z", "2026-02-30T10:00:00Z", "2026-11-23"],
  ],
  ["duration", "PT30M", ["30M", "P", "PT"]],
])(
  "requires a string with the %s format to be written in it",
  (format, valid, invalid) => {
    const declared = `:type string :format ${format}`;
    expect(accepted(declared, valid)).toBe(true);
    for (const text of invalid) {
      expect([text, accepted(declared, text)]).toEqual([text, false]);
    }
  },
);

it("requires every item of a list with a format to be written in it", () => {
  const declared = ":type list :format date";
  expect(accepted(declared, ["2026-11-23", "2026-11-24"])).toBe(true);
  expect(accepted(declared, ["2026-11-23", "tomorrow"])).toBe(false);
});

it.each<[string, string, readonly FieldValue[], readonly FieldValue[]]>([
  ["a number", ":type number :minimum 0", [0, 1.5], [-1, "1", true]],
  ["a boolean", ":type boolean", [true, false], ["true", 1]],
  [
    "a record",
    ":type record (field day :type string :format date) (field seats :type integer :optional true)",
    [{ day: "2026-11-23" }, { seats: 2, day: "2026-11-23" }],
    [{}, { day: "soon" }, { day: "2026-11-23", extra: 1 }, ["2026-11-23"]],
  ],
  [
    "a list of records",
    ":type list :min-items 1 (item :type record (field day :type string :format date))",
    [[{ day: "2026-11-23" }]],
    [[], [{ day: "soon" }], ["2026-11-23"]],
  ],
  [
    "a list of integers",
    ":type list (item :type integer :minimum 1)",
    [[1, 2], []],
    [[0], ["1"]],
  ],
])(
  "requires %s to have its declared shape",
  (...[, declared, valid, invalid]) => {
    for (const value of valid) {
      expect([value, accepted(declared, value)]).toEqual([value, true]);
    }
    for (const value of invalid) {
      expect([value, accepted(declared, value)]).toEqual([value, false]);
    }
  },
);

it("requires a list of nonempty items whose count is within its bounds", () => {
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
(act offer :by client :starts true :sets offered
  (field slots :type list :min-items 1))
(act keep :by server :when offered :sets kept
  (field slots :type list :min-items 1)
  (relation subset slots (previous offer slots)))
(act pick :by client :when kept :ends true
  (field slot :type string)
  (relation member slot (previous (fact kept) slots)))
`);

it("requires a list to be a subset of an earlier list, and a string to be one of an earlier list's items", () => {
  const item = fc.constantFrom("mon", "tue", "wed");
  fc.assert(
    fc.property(
      fc.array(item, { minLength: 1, maxLength: 3 }),
      fc.array(item, { minLength: 1, maxLength: 3 }),
      item,
      (offered, kept, picked) => {
        const history: Sent[] = [];
        const send = (author: Role, text: string) =>
          attempt(picking, history, {
            author,
            text,
            now: 1,
            reply: Option.fromNullable(history.at(-1)?.msgId),
          });

        send(client, actText("offer", "picking", { slots: offered }));
        const within = kept.every((slot) => offered.includes(slot));
        expect(send(server, actText("keep", "picking", { slots: kept }))).toBe(
          within,
        );
        expect(send(client, actText("pick", "picking", { slot: picked }))).toBe(
          within && kept.includes(picked),
        );
      },
    ),
  );
});
