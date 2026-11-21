/**
 * @file The structure check of a firewall whose agent holds norms. It replays
 * a conversation's earlier messages to find the instance in progress, then
 * says whether a further message is an act that may follow.
 */

import { Effect, Either, Struct } from "effect";
import type { Message } from "../messages.js";
import {
  type CheckedMessage,
  type StructureCheck,
  TextRule,
} from "../firewall.js";
import {
  type Act,
  checkStructure,
  type MessageForm,
  type Norm,
  type NormProblem,
  readAct,
} from "./norm.js";

/** One earlier act that fits the protocol: its message, the time of the firewall's check of it and the act its text states. */
interface ReplayedAct {
  readonly message: Message;
  readonly at: number;
  readonly act: Act;
}

/**
 * What one firewall's checks say of a conversation. `referenceActs`
 * gives the performative of each message a reply may name. `instance` is the
 * instance in progress: its norm, who holds each role, the message that
 * set each current fact, how often each act was sent, and the reply reference
 * of every message that belongs to it.
 */
interface ProtocolView {
  readonly referenceActs: ReadonlyMap<string, string | undefined>;
  readonly instance?: {
    readonly norm: Norm;
    readonly initiator: string;
    readonly participant: string;
    readonly facts: ReadonlyMap<string, ReplayedAct>;
    readonly counts: ReadonlyMap<string, number>;
    readonly acts: readonly ReplayedAct[];
    readonly references: ReadonlyMap<string, string | undefined>;
  };
}

type Instance = NonNullable<ProtocolView["instance"]>;
type Checked<Value> = Either.Either<Value, NormProblem>;

/** An act read from a message, with the norm it is held to. */
interface HeldAct {
  readonly act: Act;
  readonly norm: Norm;
}

/** A held act whose fields fit `form`, the form its norm declares for it. */
interface FittedAct extends HeldAct {
  readonly form: MessageForm;
}

/**
 * The structure check of a firewall whose agent holds `installed`. It replays
 * the earlier messages to find the instance in progress,
 * then reads the message as an act of that instance or, when none is, of the
 * norm it names. An act that fits passes with its norm's text rules for
 * it. Any other message is refused under a rule named for the norm of the
 * instance in progress and the stage that failed. Without norms every message
 * passes.
 */
export function structureCheck(installed: readonly Norm[]): StructureCheck {
  return (message, earlier, now) =>
    Effect.sync(
      (): Result =>
        installed.length === 0
          ? { kind: "passed", textRules: [] }
          : checkMessage(installed, message, earlier, now),
    ).pipe(Effect.withSpan("structureCheck"));
}

/** What the structure check says of `message` at `now`, after the `earlier` messages of its conversation. */
function checkMessage(
  installed: readonly Norm[],
  message: Message,
  earlier: readonly CheckedMessage[],
  now: number,
): Result {
  const view = projectProtocol(installed, earlier);
  const held = readHeldAct(view, installed, message);
  return Either.match(
    Either.flatMap(held, (read) => fitAct(view, read, message, now)),
    {
      onLeft: (problem) =>
        refusal(view, problem, Either.getOrUndefined(held)?.norm),
      onRight: (fitted) => pass(view, fitted),
    },
  );
}

type Result = Effect.Effect.Success<ReturnType<StructureCheck>>;

/**
 * The refusal of a message with `problem`, under a rule named for the norm of
 * the instance in progress and the stage that failed. Its detail names
 * `selected`, the norm the message was read as an act of, when there is one.
 */
function refusal(
  view: ProtocolView,
  problem: NormProblem,
  selected?: Norm,
): Result {
  return {
    kind: "refused",
    reason: problem.reason,
    ruleId: `${view.instance?.norm.name ?? "norm"}-${problem.stage}`,
    feedback: problem.detail,
    detail: {
      norm: selected?.name,
      digest: selected?.digest,
      stage: problem.stage,
      explanation: problem.detail,
      field: problem.field,
    },
  };
}

/**
 * The pass of an act that fits: the text rules its norm gives the act and
 * every act, and what the decision provider reads of the instance.
 */
function pass(view: ProtocolView, { act, norm, form }: FittedAct): Result {
  const named = { norm: norm.name, digest: norm.digest };
  return {
    kind: "passed",
    textRules: norm.textRules
      .filter((rule) => rule.act === undefined || rule.act === act.name)
      .map(
        (rule) =>
          new TextRule({ ...Struct.omit(rule, "act"), applies: "both" }),
      ),
    protocol: {
      ...named,
      act: act.name,
      description: norm.description,
      state: [...(view.instance?.facts.keys() ?? [])],
      form: form.fields,
    },
    detail: { ...named, act: act.name, stage: "semantic" },
  };
}

/**
 * Replays a conversation's earlier messages in order under the held norms.
 * Only a message the firewall checked that reads as an act and fits the
 * protocol at the time of its check advances the instance.
 */
function projectProtocol(
  installed: readonly Norm[],
  earlier: readonly CheckedMessage[],
): ProtocolView {
  const referenceActs = new Map<string, string | undefined>();
  let view: ProtocolView = { referenceActs };
  for (const entry of earlier) {
    const act = replayed(view, installed, entry);
    if (act !== undefined) {
      view = advance(view, act);
    }
    view = retainInteractionReference(view, entry.message);
    referenceActs.set(entry.message.msgId, act?.act.name);
  }
  return view;
}

/**
 * The act of an earlier message, as the view permitted it at the time of the
 * firewall's check, or nothing when the firewall did not check the message or
 * the message is no such act.
 */
function replayed(
  view: ProtocolView,
  installed: readonly Norm[],
  { message, checkedAt }: CheckedMessage,
) {
  return checkedAt === undefined
    ? undefined
    : readHeldAct(view, installed, message).pipe(
        Either.flatMap((held) => fitAct(view, held, message, checkedAt)),
        Either.map((fitted) => ({ ...fitted, message, at: checkedAt })),
        Either.getOrUndefined,
      );
}

/**
 * Reads `message` as an act of the instance in progress or, when none is, of
 * the held norm it names.
 */
function readHeldAct(
  view: ProtocolView,
  installed: readonly Norm[],
  message: Message,
): Checked<HeldAct> {
  return Either.flatMap(readAct(message), (act) => {
    const norm =
      view.instance?.norm ?? installed.find((held) => held.name === act.norm);
    return norm === undefined
      ? Either.left({
          stage: "structural",
          reason: "rule-violation",
          detail: "ontology must name an installed norm.",
          field: "ontology",
        })
      : Either.right({ act, norm });
  });
}

/** The act of `message` with its form, once its structure fits its norm and the view permits it at `now`. */
function fitAct(
  view: ProtocolView,
  held: HeldAct,
  message: Message,
  now: number,
): Checked<FittedAct> {
  return Either.flatMap(checkStructure(held.norm, held.act), (form) => {
    const fitted = { ...held, form };
    return Either.map(checkProtocol(view, fitted, message, now), () => fitted);
  });
}

/**
 * Why the view does not permit the fitted act, which `message` states, next.
 * A continuation that replies outside the instance, comes before its delay
 * or breaks a relation gets the one refusal of an act that may not follow.
 */
function checkProtocol(
  view: ProtocolView,
  fitted: FittedAct,
  message: Message,
  now: number,
): Either.Either<void, NormProblem> {
  const { act, norm, form } = fitted;
  const invalid = invalidTransition(view, norm, message, act);
  return Either.gen(function* () {
    yield* checkReference(view, form, message);
    const instance = view.instance;
    if (instance === undefined) {
      return yield* form.starts ? Either.void : Either.left(invalid);
    }
    if (form.starts) {
      return yield* Either.left(invalid);
    }
    const author = message.author;
    const role = roleOf(instance, author);
    const ancestry = referenceAncestry(instance, message.replyToMsgId);
    if (ancestry.size === 0) {
      return yield* Either.left(invalid);
    }
    const anchor =
      "recipient" in form.by
        ? instance.facts.get(form.by.recipient.fact)
        : undefined;
    if (
      "recipient" in form.by &&
      (anchor === undefined || !ancestry.has(anchor.message.msgId))
    ) {
      return yield* Either.left(invalid);
    }
    if (!senderPermitted(form, author, role, anchor)) {
      return yield* Either.left(
        violation(
          `${act.name} is not permitted for ${norm.name} role ${role ?? "unassigned"}.`,
        ),
      );
    }
    if (!enabled(form, instance)) {
      return yield* Either.left(invalid);
    }
    if (form.delay !== undefined) {
      yield* checkDelay(instance, form.delay, now, invalid);
    }
    return yield* checkRelations(instance, fitted, ancestry, invalid);
  });
}

function senderPermitted(
  form: MessageForm,
  author: string,
  role?: string,
  anchor?: ReplayedAct,
) {
  if (role === undefined) {
    return false;
  }
  return "recipient" in form.by
    ? anchor?.message.recipient === author
    : form.by.includes(role);
}

/** A message that replies into the instance belongs to it, whether or not it advanced the instance, so a later reply may name it. */
function retainInteractionReference(view: ProtocolView, message: Message) {
  const instance = view.instance;
  if (instance === undefined) {
    return view;
  }
  const reference = message.replyToMsgId;
  const belongs =
    instance.acts[0]?.message.msgId === message.msgId ||
    (reference !== undefined && instance.references.has(reference));
  return belongs
    ? {
        ...view,
        instance: {
          ...instance,
          references: new Map([
            ...instance.references,
            [message.msgId, reference],
          ]),
        },
      }
    : view;
}

/** The refusal of an act that may not follow, naming the act its reply reference points at when that is known. */
function invalidTransition(
  view: ProtocolView,
  norm: Norm,
  message: Message,
  act: Act,
) {
  const preceding =
    message.replyToMsgId === undefined
      ? undefined
      : view.referenceActs.get(message.replyToMsgId);
  const after = preceding === undefined ? "" : ` after ${preceding}`;
  return violation(`${act.name} is not valid${after} for ${norm.name}.`);
}

/** Whether the message's reply reference suits `form`: an opening may omit it, and a reference names a message of the conversation. */
function checkReference(
  view: ProtocolView,
  form: MessageForm,
  { replyToMsgId }: Message,
): Either.Either<void, NormProblem> {
  if (replyToMsgId === undefined) {
    return form.starts
      ? Either.void
      : Either.left(
          violation(
            "replyToMsgId is required for a continuation act.",
            "replyToMsgId",
          ),
        );
  }
  return view.referenceActs.has(replyToMsgId)
    ? Either.void
    : Either.left(
        violation(
          "replyToMsgId does not identify a preceding message in this conversation.",
          "replyToMsgId",
        ),
      );
}

function checkDelay(
  instance: Instance,
  delay: NonNullable<MessageForm["delay"]>,
  now: number,
  invalid: NormProblem,
): Either.Either<void, NormProblem> {
  const permittedAt = permittedTime(instance, delay);
  if (permittedAt === undefined) {
    return Either.left(
      unavailable("The declared delay has no retained numeric anchor."),
    );
  }
  return now < permittedAt ? Either.left(invalid) : Either.void;
}

function checkRelations(
  instance: Instance,
  { form, act }: FittedAct,
  ancestry: ReadonlySet<string>,
  invalid: NormProblem,
): Either.Either<void, NormProblem> {
  return Either.gen(function* () {
    for (const { field, operator, source } of form.relations) {
      const expected = yield* sourceValue(instance, source, ancestry, invalid);
      const actual = act.fields[field];
      if (actual === undefined || !related(operator, actual, expected)) {
        return yield* Either.left(invalid);
      }
    }
  });
}

/** The view once `entry`, an act the protocol permits, is applied: it opens an instance, changes the one in progress or ends it. */
function advance(
  view: ProtocolView,
  entry: ReplayedAct & FittedAct,
): ProtocolView {
  const { norm, form } = entry;
  if (form.ends) {
    return { ...view, instance: undefined };
  }
  const prior: Instance = view.instance ?? {
    norm,
    initiator: entry.message.author,
    participant: entry.message.recipient,
    facts: new Map(),
    counts: new Map(),
    acts: [],
    references: new Map(),
  };
  const facts = new Map(prior.facts);
  const counts = new Map(prior.counts);
  for (const fact of form.terminates) {
    facts.delete(fact);
  }
  for (const fact of form.initiates) {
    facts.set(fact, entry);
  }
  counts.set(form.act, (counts.get(form.act) ?? 0) + 1);
  return {
    ...view,
    instance: { ...prior, facts, counts, acts: [...prior.acts, entry] },
  };
}

function roleOf(instance: Instance, author: string) {
  if (author === instance.initiator) {
    return instance.norm.roles.initiator;
  }
  return author === instance.participant
    ? instance.norm.roles.participant
    : undefined;
}

function enabled(form: MessageForm, instance: Instance) {
  const facts = form.when.every((fact) => instance.facts.has(fact));
  const count =
    form.maximum === undefined ||
    (instance.counts.get(form.act) ?? 0) < form.maximum;
  return facts && count;
}

/** The messages a reply reference leads back through, within the instance. */
function referenceAncestry(instance: Instance, reference?: string) {
  const ancestry = new Set<string>();
  let current = reference;
  while (
    current !== undefined &&
    !ancestry.has(current) &&
    instance.references.has(current)
  ) {
    ancestry.add(current);
    current = instance.references.get(current);
  }
  return ancestry;
}

function permittedTime(
  instance: Instance,
  delay: NonNullable<MessageForm["delay"]>,
) {
  const fact = instance.facts.get(delay.fact);
  const duration = fact?.act.fields[delay.field];
  return fact !== undefined && typeof duration === "number"
    ? fact.at + duration * 1000
    : undefined;
}

function related(
  operator: MessageForm["relations"][number]["operator"],
  actual: Act["fields"][string],
  expected: Act["fields"][string],
) {
  switch (operator) {
    case "equals":
      return JSON.stringify(actual) === JSON.stringify(expected);
    case "member":
      return (
        Array.isArray(expected) && expected.some((item) => item === actual)
      );
    case "subset":
      return (
        Array.isArray(actual) &&
        Array.isArray(expected) &&
        actual.every((item) => expected.includes(item))
      );
    default: {
      const exhaustive: never = operator;
      return exhaustive;
    }
  }
}

function sourceValue(
  instance: Instance,
  source: MessageForm["relations"][number]["source"],
  ancestry: ReadonlySet<string>,
  invalid: NormProblem,
): Checked<Act["fields"][string]> {
  const fields = referencedAct(instance, source.act, ancestry)?.act.fields;
  if (fields === undefined) {
    return Either.left(invalid);
  }
  if (source.kind === "field") {
    const value = fields[source.field];
    return value === undefined
      ? Either.left(
          unavailable(
            "A declared relation needs an earlier field that is missing.",
          ),
        )
      : Either.right(value);
  }
  const present = (names: readonly string[]) =>
    names.filter((field) => Object.hasOwn(fields, field));
  if (source.kind === "present") {
    return Either.right(present(source.fields));
  }
  const keys =
    source.kind === "field-values"
      ? Either.right(present(source.fields))
      : sourceValue(instance, source.keys, ancestry, invalid);
  return Either.flatMap(keys, (selected) => {
    if (typeof selected !== "object") {
      return Either.left(
        unavailable("A selected-values relation needs a list of field names."),
      );
    }
    const values = selected.flatMap((key) => {
      const value = fields[key];
      return typeof value === "string" ? [value] : [];
    });
    return values.length === selected.length
      ? Either.right(values)
      : Either.left(
          unavailable("A selected value is missing or is not a string."),
        );
  });
}

function referencedAct(
  instance: Instance,
  act: MessageForm["relations"][number]["source"]["act"],
  ancestry: ReadonlySet<string>,
) {
  if (typeof act !== "string") {
    const anchor = instance.facts.get(act.fact);
    return anchor === undefined || !ancestry.has(anchor.message.msgId)
      ? undefined
      : anchor;
  }
  return [...instance.acts]
    .reverse()
    .find(
      (entry) => ancestry.has(entry.message.msgId) && entry.act.name === act,
    );
}

function violation(detail: string, field?: string): NormProblem {
  return { stage: "protocol", reason: "rule-violation", detail, field };
}

function unavailable(detail: string): NormProblem {
  return { stage: "protocol", reason: "unresolved-evidence", detail };
}
