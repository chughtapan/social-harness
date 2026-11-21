/**
 * @file The structure check: what runs a norm. It replays a conversation's
 * earlier messages to find the instance in progress, then says whether a
 * further message is an act its sender may send next. It reads norms, acts
 * and messages as plain data, and is handed the reader that turns a
 * message's text into an act.
 */

import { Either } from "effect";
import {
  type Act,
  type ActReference,
  type Delay,
  describedFields,
  type Field,
  type Form,
  type Norm,
  type Relation,
  type Role,
  type Value,
} from "./norm.js";

/**
 * A message as the structure check reads it: its id, the id of the message
 * it replies to, which member sent it and its text. `at` is the time of the
 * check of it, in milliseconds. A stored message that was never checked has
 * none and is replayed as no act, and the message under check takes the time
 * given beside it.
 */
export interface Sent {
  readonly id: string;
  readonly replyTo?: string;
  readonly role: Role;
  readonly text: string;
  readonly at?: number;
}

/**
 * One text rule: a requirement in prose that a decision provider judges a
 * message against. The sender of a message it refuses reads the same text as
 * feedback, so a rule says what the message must do.
 */
export interface TextRule {
  readonly id: string;
  readonly text: string;
}

/**
 * What the structure check says of one message. A refusal gives the rule it
 * is recorded under and, as `feedback`, what does not fit. A pass gives the
 * text rules that judge the message and the `protocol` context a decision
 * provider reads with them.
 */
export type Judgement =
  | {
      readonly kind: "refused";
      readonly reason: NormProblem["reason"];
      readonly ruleId: string;
      readonly feedback: string;
    }
  | {
      readonly kind: "passed";
      readonly textRules: readonly TextRule[];
      readonly protocol?: unknown;
    };

/** Why a message fails its norm: the stage that failed, and the feedback its sender reads. */
interface NormProblem {
  readonly stage: "structural" | "protocol";
  readonly reason: "rule-violation" | "unresolved-evidence";
  readonly feedback: string;
}

type Checked<Value> = Either.Either<Value, NormProblem>;

/** A message with the time of its check. */
type Timed = Sent & { readonly at: number };

/** An act that fits: the act, the norm it is judged under and the form that norm declares for it. */
interface Fitted {
  readonly act: Act;
  readonly norm: Norm;
  readonly form: Form;
}

/**
 * Reads a text as an act and fits it to its form, under the norm of the
 * instance in progress or, when none is, the held norm the act names. It
 * also gives the norm the text was judged under, which names a refusal's
 * rule: a text that is no act is judged under the instance's norm, and under
 * none when no instance is in progress.
 */
type Fit = (
  text: string,
  instance?: Norm,
) => { readonly norm?: Norm; readonly fitted: Checked<Fitted> };

/** One earlier act that fits the protocol, with the message that states it. */
type AllowedAct = Fitted & Timed;

/**
 * What replaying a conversation finds. `known` gives the performative of
 * each stored message a reply may name. `instance` is the instance in
 * progress: its norm, the act that set each fact that holds, how often each
 * performative was sent, its acts in order, and the reply reference of every
 * message that belongs to it.
 */
interface Progress {
  readonly known: ReadonlyMap<string, string | undefined>;
  readonly instance?: {
    readonly norm: Norm;
    readonly facts: ReadonlyMap<string, AllowedAct>;
    readonly counts: ReadonlyMap<string, number>;
    readonly acts: readonly AllowedAct[];
    readonly members: ReadonlyMap<string, string | undefined>;
  };
}

type Instance = NonNullable<Progress["instance"]>;

/**
 * The structure check of a server that holds `norms` and reads each
 * message's text with `readAct`. It judges `sent` at the time `now`, after
 * the `earlier` messages of its conversation: it replays them to find the
 * instance in progress, then reads the message as an act of that instance
 * or, when none is, of the norm it names. An act that fits passes with a
 * text rule for each described field it states. Any other message is refused
 * under a rule named for the norm it was judged under and the stage that
 * failed. Without norms every message passes.
 */
export function structureCheck(
  norms: readonly Norm[],
  readAct: (text: string) => Either.Either<Act, string>,
): (sent: Sent, earlier: readonly Sent[], now: number) => Judgement {
  const fit: Fit = (text, instance) => {
    const read = Either.mapLeft(readAct(text), structural);
    const named = Either.getOrUndefined(read)?.norm;
    const norm = instance ?? norms.find(({ name }) => name === named);
    return { norm, fitted: Either.flatMap(read, (act) => fitForm(act, norm)) };
  };
  return (sent, earlier, now) => {
    if (norms.length === 0) {
      return { kind: "passed", textRules: [] };
    }
    const progress = replay(fit, earlier);
    const { norm, allowed } = judge(progress, fit, { ...sent, at: now });
    return Either.match(allowed, {
      onLeft: (problem) => refusal(problem, norm),
      onRight: (act) => pass(progress, act),
    });
  };
}

/**
 * The refusal of a message with `problem`, under a rule named for the stage
 * that failed and `norm`, the norm the message was judged under. A message
 * judged under no norm has the word `norm` there.
 */
function refusal(problem: NormProblem, norm?: Norm): Judgement {
  return {
    kind: "refused",
    reason: problem.reason,
    ruleId: `${norm?.name ?? "norm"}-${problem.stage}`,
    feedback: problem.feedback,
  };
}

/**
 * The pass of an act that fits: a text rule for each described field the act
 * states, which holds the field's text to its description, and what the
 * decision provider reads of the instance.
 */
function pass(progress: Progress, { act, norm, form }: Fitted): Judgement {
  return {
    kind: "passed",
    textRules: describedFields(form).flatMap(
      ({ name, subject, description }) =>
        Object.hasOwn(act.fields, name)
          ? [
              {
                id: `${norm.name}.${act.performative}.${name}`,
                text: `${subject} must hold what its description says and nothing else: ${description}`,
              },
            ]
          : [],
    ),
    protocol: {
      norm: norm.name,
      digest: norm.digest,
      act: act.performative,
      description: norm.description,
      state: [...(progress.instance?.facts.keys() ?? [])],
      form: form.fields,
    },
  };
}

/**
 * Replays a conversation's earlier messages in order under the held norms.
 * Only a checked message that passes every step at the time of its check
 * has its effects. Every message is known afterwards, and may join the
 * instance in progress.
 */
function replay(fit: Fit, earlier: readonly Sent[]): Progress {
  const known = new Map<string, string | undefined>();
  let progress: Progress = { known };
  for (const stored of earlier) {
    const act =
      stored.at === undefined
        ? undefined
        : Either.getOrUndefined(
            judge(progress, fit, { ...stored, at: stored.at }).allowed,
          );
    if (act !== undefined && stored.at !== undefined) {
      progress = applyAct(progress, { ...act, ...stored, at: stored.at });
    }
    progress = joinInstance(progress, stored);
    known.set(stored.id, act?.act.performative);
  }
  return progress;
}

/**
 * Judges one message by every step: whether its text is an act that fits its
 * form, and whether the conversation's progress permits that act at the time
 * of its check. It also gives the norm the message was judged under.
 */
function judge(progress: Progress, fit: Fit, sent: Timed) {
  const { norm, fitted } = fit(sent.text, progress.instance?.norm);
  return {
    norm,
    allowed: Either.flatMap(fitted, (act) =>
      Either.map(checkProtocol(progress, act, sent), () => act),
    ),
  };
}

/**
 * Why the conversation's progress does not permit the fitted act of `sent`. A
 * continuation that replies outside the instance, comes before its delay or
 * breaks a relation gets the one refusal of an act that may not follow.
 */
function checkProtocol(
  progress: Progress,
  fitted: Fitted,
  sent: Timed,
): Either.Either<void, NormProblem> {
  const { act, norm, form } = fitted;
  const { role } = sent;
  const invalid = invalidTransition(progress, norm, sent, act);
  const notTheirs = violation(
    `${act.performative} is not the ${role}'s to send in ${norm.name}.`,
  );
  return Either.gen(function* () {
    yield* checkReference(progress, form, sent);
    const instance = progress.instance;
    if (instance === undefined) {
      const opening = senderPermitted(form, sent)
        ? Either.void
        : Either.left(notTheirs);
      return yield* form.starts ? opening : Either.left(invalid);
    }
    if (form.starts) {
      return yield* Either.left(invalid);
    }
    const chain = replyChain(instance, sent.replyTo);
    if (chain.size === 0) {
      return yield* Either.left(invalid);
    }
    const anchor =
      form.by.kind === "recipient"
        ? instance.facts.get(form.by.fact)
        : undefined;
    if (
      form.by.kind === "recipient" &&
      (anchor === undefined || !chain.has(anchor.id))
    ) {
      return yield* Either.left(invalid);
    }
    if (!senderPermitted(form, sent, anchor)) {
      return yield* Either.left(notTheirs);
    }
    if (!enabled(form, instance)) {
      return yield* Either.left(invalid);
    }
    if (form.delay !== undefined) {
      yield* checkDelay(instance, form.delay, sent.at, invalid);
    }
    return yield* checkRelations(instance, fitted, chain, invalid);
  });
}

/**
 * Whether the form lets the sender of `sent` send its act: by its role, or
 * as the recipient of the message that set the form's fact. A conversation
 * has two members, so that recipient is the member who did not send it.
 */
function senderPermitted({ by }: Form, { role }: Sent, anchor?: AllowedAct) {
  return by.kind === "recipient"
    ? anchor !== undefined && anchor.role !== role
    : by.roles.includes(role);
}

/** A message that replies into the instance belongs to it, whether or not it advanced the instance, so a later reply may name it. */
function joinInstance(progress: Progress, { id, replyTo }: Sent) {
  const instance = progress.instance;
  if (instance === undefined) {
    return progress;
  }
  const belongs =
    instance.acts[0]?.id === id ||
    (replyTo !== undefined && instance.members.has(replyTo));
  return belongs
    ? {
        ...progress,
        instance: {
          ...instance,
          members: new Map([...instance.members, [id, replyTo]]),
        },
      }
    : progress;
}

/** The refusal of an act that may not follow, naming the act its reply reference points at when that is known. */
function invalidTransition(
  progress: Progress,
  norm: Norm,
  { replyTo }: Sent,
  act: Act,
) {
  const preceding =
    replyTo === undefined ? undefined : progress.known.get(replyTo);
  const after = preceding === undefined ? "" : ` after ${preceding}`;
  return violation(
    `${act.performative} is not valid${after} for ${norm.name}.`,
  );
}

/** Whether the message's reply reference suits `form`: an opening may omit it, and a reference names a message of the conversation. */
function checkReference(
  progress: Progress,
  form: Form,
  { replyTo }: Sent,
): Either.Either<void, NormProblem> {
  if (replyTo === undefined) {
    return form.starts
      ? Either.void
      : Either.left(
          violation("replyToMsgId is required for a continuation act."),
        );
  }
  return progress.known.has(replyTo)
    ? Either.void
    : Either.left(
        violation(
          "replyToMsgId does not identify a preceding message in this conversation.",
        ),
      );
}

function checkDelay(
  instance: Instance,
  delay: Delay,
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
  { form, act }: Fitted,
  chain: ReadonlySet<string>,
  invalid: NormProblem,
): Either.Either<void, NormProblem> {
  return Either.gen(function* () {
    for (const { field, operator, source } of form.relations) {
      const expected = yield* sourceValue(instance, source, chain, invalid);
      const actual = act.fields[field];
      if (actual === undefined || !related(operator, actual, expected)) {
        return yield* Either.left(invalid);
      }
    }
  });
}

/** A conversation's progress once `entry`, an allowed act, has its effects: it ends the instance, or opens one when none is in progress and then clears and sets facts. */
function applyAct(progress: Progress, entry: AllowedAct): Progress {
  const { norm, form } = entry;
  if (form.ends) {
    return { ...progress, instance: undefined };
  }
  const prior: Instance = progress.instance ?? {
    norm,
    facts: new Map(),
    counts: new Map(),
    acts: [],
    members: new Map(),
  };
  const facts = new Map(prior.facts);
  const counts = new Map(prior.counts);
  for (const fact of form.terminates) {
    facts.delete(fact);
  }
  for (const fact of form.initiates) {
    facts.set(fact, entry);
  }
  counts.set(form.performative, (counts.get(form.performative) ?? 0) + 1);
  return {
    ...progress,
    instance: { ...prior, facts, counts, acts: [...prior.acts, entry] },
  };
}

/** Whether every fact the form needs holds and fewer acts of it than its limit were sent. */
function enabled(form: Form, instance: Instance) {
  const facts = form.when.every((fact) => instance.facts.has(fact));
  const count =
    form.max === undefined ||
    (instance.counts.get(form.performative) ?? 0) < form.max;
  return facts && count;
}

/** The messages a reply reference leads back through, within the instance. */
function replyChain(instance: Instance, reference?: string) {
  const chain = new Set<string>();
  let current = reference;
  while (
    current !== undefined &&
    !chain.has(current) &&
    instance.members.has(current)
  ) {
    chain.add(current);
    current = instance.members.get(current);
  }
  return chain;
}

function permittedTime(instance: Instance, delay: Delay) {
  const fact = instance.facts.get(delay.fact);
  const duration = fact?.act.fields[delay.field];
  return fact !== undefined && typeof duration === "number"
    ? fact.at + duration * 1000
    : undefined;
}

function related(
  operator: Relation["operator"],
  actual: Value,
  expected: Value,
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

/** The value a relation holds a field to: the source's field of the earlier act it names, which the reply chain must hold. An optional field the act left out settles nothing. */
function sourceValue(
  instance: Instance,
  source: Relation["source"],
  chain: ReadonlySet<string>,
  invalid: NormProblem,
): Checked<Value> {
  const fields = referencedAct(instance, source.act, chain)?.act.fields;
  if (fields === undefined) {
    return Either.left(invalid);
  }
  const value = fields[source.field];
  return value === undefined
    ? Either.left(
        unavailable(
          "A declared relation needs an earlier field that is missing.",
        ),
      )
    : Either.right(value);
}

/** The earlier act a reference names, when the reply chain holds it: the one that set a fact, or the latest of a performative. */
function referencedAct(
  instance: Instance,
  reference: ActReference,
  chain: ReadonlySet<string>,
) {
  if (reference.kind === "fact") {
    const anchor = instance.facts.get(reference.fact);
    return anchor === undefined || !chain.has(anchor.id) ? undefined : anchor;
  }
  return [...instance.acts]
    .reverse()
    .find(
      (entry) =>
        chain.has(entry.id) &&
        entry.act.performative === reference.performative,
    );
}

/**
 * `act` with the norm it is judged under and the form that norm declares for
 * it, once the server holds a norm for it, the act names that norm and its
 * fields fit the form: every required field stated, every stated field
 * declared, and each value of its field's type and within its bounds. The
 * refusal names every field at fault.
 */
function fitForm(act: Act, norm?: Norm): Checked<Fitted> {
  const { performative, fields } = act;
  if (norm === undefined) {
    return Either.left(
      structural("The act's norm is not one this server holds."),
    );
  }
  const form = norm.forms.find((entry) => entry.performative === performative);
  if (norm.name !== act.norm) {
    return Either.left(
      violation(
        `${performative} is not valid for the active norm ${norm.name}.`,
      ),
    );
  }
  if (form === undefined) {
    return Either.left(
      structural(`${performative} is not a valid act in ${act.norm}.`),
    );
  }
  const failures = [
    ...form.fields.flatMap((field) => {
      const value = Object.hasOwn(fields, field.name)
        ? fields[field.name]
        : undefined;
      if (value === undefined) {
        return field.optional
          ? []
          : [`${field.name} is required for ${performative} in ${act.norm}.`];
      }
      return accepts(field, value)
        ? []
        : [`${field.name} is not valid for ${performative} in ${act.norm}.`];
    }),
    ...Object.keys(fields)
      .filter((stated) => form.fields.every((field) => field.name !== stated))
      .map(
        (stated) =>
          `${stated} is not a valid field of ${performative} in ${act.norm}.`,
      ),
  ];
  return failures.length === 0
    ? Either.right({ act, norm, form })
    : Either.left(structural(failures.join(" ")));
}

/** Whether `value` has the type of `field` and lies within its bounds. A string's length counts code points. */
function accepts(field: Field, value: Value): boolean {
  switch (field.type) {
    case "string":
      return (
        typeof value === "string" &&
        within(Array.from(value).length, field.minLength, field.maxLength)
      );
    case "integer":
      return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        within(value, field.minimum, field.maximum)
      );
    case "list":
      return (
        typeof value === "object" &&
        value.every((item) => item !== "") &&
        within(value.length, field.minItems, field.maxItems)
      );
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

function within(value: number, minimum?: number, maximum?: number) {
  return (
    (minimum === undefined || value >= minimum) &&
    (maximum === undefined || value <= maximum)
  );
}

function structural(feedback: string): NormProblem {
  return { stage: "structural", reason: "rule-violation", feedback };
}

function violation(feedback: string): NormProblem {
  return { stage: "protocol", reason: "rule-violation", feedback };
}

function unavailable(feedback: string): NormProblem {
  return { stage: "protocol", reason: "unresolved-evidence", feedback };
}
