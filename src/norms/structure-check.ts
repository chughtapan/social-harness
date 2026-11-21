/**
 * @file The structure check of a server that holds norms: what runs a norm.
 * It replays a conversation's earlier messages to find the instance in
 * progress, then says whether a further message is an act its sender may
 * send next. It reads norms and acts as data, and is handed the reader that
 * turns a message's text into an act.
 */

import { Effect, Either } from "effect";
import type { CheckedMessage, StructureCheck } from "../firewall.js";
import type { Message, Role } from "../messages.js";
import {
  type Act,
  type ActReference,
  type Delay,
  describedFields,
  type Field,
  type Form,
  type Norm,
  type Relation,
  type Value,
} from "./norm.js";

/** Reads a message's text as an act, or says why it is none and which field is at fault. */
type ActReader = (
  text: string,
) => Either.Either<Act, { readonly detail: string; readonly field?: string }>;

/** Why a message fails its norm: the stage that failed, and the text its sender reads. */
interface NormProblem {
  readonly stage: "structural" | "protocol";
  readonly reason: "rule-violation" | "unresolved-evidence";
  readonly detail: string;
  readonly field?: string;
}

/** A message as the structure check judges it: which member sent it, and the time of the firewall's check of it. */
interface Sent {
  readonly message: Message;
  readonly role: Role;
  readonly at: number;
}

/** One earlier act that fits the protocol, with the act its text states. */
interface ReplayedAct extends Sent {
  readonly act: Act;
}

/**
 * What the firewall's checks say of a conversation. `known` gives
 * the performative of each message a reply may name. `instance` is the
 * instance in progress: its norm, the message that set each current fact,
 * how often each act was sent, and the reply reference of every message that
 * belongs to it.
 */
interface Progress {
  readonly known: ReadonlyMap<string, string | undefined>;
  readonly instance?: {
    readonly norm: Norm;
    readonly facts: ReadonlyMap<string, ReplayedAct>;
    readonly counts: ReadonlyMap<string, number>;
    readonly acts: readonly ReplayedAct[];
    readonly members: ReadonlyMap<string, string | undefined>;
  };
}

type Instance = NonNullable<Progress["instance"]>;
type Checked<Value> = Either.Either<Value, NormProblem>;

/** An act read from a message, with the norm it is held to. */
interface HeldAct {
  readonly act: Act;
  readonly norm: Norm;
}

/** A held act whose fields fit `form`, the form its norm declares for it. */
interface FittedAct extends HeldAct {
  readonly form: Form;
}

/** The norms a server holds, with the reader of its messages. */
interface Held {
  readonly norms: readonly Norm[];
  readonly readAct: ActReader;
}

/**
 * The structure check of a server that holds `norms` and reads each
 * message's text with `readAct`. It replays the earlier messages to find the
 * instance in progress, then reads the message as an act of that instance
 * or, when none is, of the norm it names. An act that fits passes with a
 * text rule for each described field it states. Any other message is refused
 * under a rule named for the norm it was judged under and the stage that
 * failed. Without norms every message passes.
 */
export function structureCheck(
  norms: readonly Norm[],
  readAct: ActReader,
): StructureCheck {
  return (sender, message, earlier, now) =>
    Effect.sync(
      (): Result =>
        norms.length === 0
          ? { kind: "passed", textRules: [] }
          : checkMessage(
              { norms, readAct },
              { message, role: sender, at: now },
              earlier,
            ),
    ).pipe(Effect.withSpan("structureCheck"));
}

/** What the structure check says of `sent`, after the `earlier` messages of its conversation. */
function checkMessage(
  held: Held,
  sent: Sent,
  earlier: readonly CheckedMessage[],
): Result {
  const progress = replay(held, earlier, sent);
  const read = readHeldAct(progress, held, sent.message);
  return Either.match(
    Either.flatMap(read, (act) => fitAct(progress, act, sent)),
    {
      onLeft: (problem) =>
        refusal(progress, problem, Either.getOrUndefined(read)?.norm),
      onRight: (fitted) => pass(progress, fitted),
    },
  );
}

type Result = Effect.Effect.Success<ReturnType<StructureCheck>>;

/**
 * The refusal of a message with `problem`, under a rule named for the stage
 * that failed and the norm the message was judged under: `selected`, the
 * norm it was read as an act of, or the norm of the instance in progress
 * when its text is no act. A message judged under no norm has the word
 * `norm` there. The detail names `selected` when there is one.
 */
function refusal(
  progress: Progress,
  problem: NormProblem,
  selected?: Norm,
): Result {
  const judgedUnder = selected ?? progress.instance?.norm;
  return {
    kind: "refused",
    reason: problem.reason,
    ruleId: `${judgedUnder?.name ?? "norm"}-${problem.stage}`,
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
 * The pass of an act that fits: a text rule for each described field the act
 * states, which holds the field's text to its description, and what the
 * decision provider reads of the instance.
 */
function pass(progress: Progress, { act, norm, form }: FittedAct): Result {
  const named = { norm: norm.name, digest: norm.digest };
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
      ...named,
      act: act.performative,
      description: norm.description,
      state: [...(progress.instance?.facts.keys() ?? [])],
      form: form.fields,
    },
    detail: { ...named, act: act.performative, stage: "semantic" },
  };
}

/**
 * Replays a conversation's earlier messages in order under the held norms.
 * Only a message the firewall checked that reads as an act and fits the
 * protocol at the time of its check advances the instance. A conversation
 * has two members, so an earlier message has the role of `next`, the message
 * under check, when the same agent wrote it, and the other role otherwise.
 */
function replay(
  held: Held,
  earlier: readonly CheckedMessage[],
  next: Sent,
): Progress {
  const other = next.role === "client" ? "server" : "client";
  const known = new Map<string, string | undefined>();
  let progress: Progress = { known };
  for (const { message, checkedAt } of earlier) {
    const role = message.author === next.message.author ? next.role : other;
    const act =
      checkedAt === undefined
        ? undefined
        : replayed(progress, held, { message, role, at: checkedAt });
    if (act !== undefined) {
      progress = applyAct(progress, act);
    }
    progress = joinInstance(progress, message);
    known.set(message.msgId, act?.act.performative);
  }
  return progress;
}

/** The act of an earlier message, judged again at the time of the firewall's check of it, or nothing when it does not pass. */
function replayed(progress: Progress, held: Held, sent: Sent) {
  return readHeldAct(progress, held, sent.message).pipe(
    Either.flatMap((act) => fitAct(progress, act, sent)),
    Either.map((fitted) => ({ ...fitted, ...sent })),
    Either.getOrUndefined,
  );
}

/**
 * Reads `message` as an act of the instance in progress or, when none is, of
 * the held norm it names.
 */
function readHeldAct(
  progress: Progress,
  { norms, readAct }: Held,
  message: Message,
): Checked<HeldAct> {
  return readAct(message.text).pipe(
    Either.mapLeft(({ detail, field }) => structural(detail, field)),
    Either.flatMap((act) => {
      const norm =
        progress.instance?.norm ?? norms.find(({ name }) => name === act.norm);
      return norm === undefined
        ? Either.left(structural("ontology must name a held norm.", "ontology"))
        : Either.right({ act, norm });
    }),
  );
}

/** The act of `sent` with its form, once its fields fit the form and the conversation's progress permits it at the time of its check. */
function fitAct(
  progress: Progress,
  held: HeldAct,
  sent: Sent,
): Checked<FittedAct> {
  return Either.flatMap(fitForm(held.norm, held.act), (form) => {
    const fitted = { ...held, form };
    return Either.map(checkProtocol(progress, fitted, sent), () => fitted);
  });
}

/**
 * Why the conversation's progress does not permit the fitted act of `sent`. A
 * continuation that replies outside the instance, comes before its delay or
 * breaks a relation gets the one refusal of an act that may not follow.
 */
function checkProtocol(
  progress: Progress,
  fitted: FittedAct,
  sent: Sent,
): Either.Either<void, NormProblem> {
  const { act, norm, form } = fitted;
  const { message, role } = sent;
  const invalid = invalidTransition(progress, norm, message, act);
  const notTheirs = violation(
    `${act.performative} is not the ${role}'s to send in ${norm.name}.`,
  );
  return Either.gen(function* () {
    yield* checkReference(progress, form, message);
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
    const chain = replyChain(instance, message.replyToMsgId);
    if (chain.size === 0) {
      return yield* Either.left(invalid);
    }
    const anchor =
      form.by.kind === "recipient"
        ? instance.facts.get(form.by.fact)
        : undefined;
    if (
      form.by.kind === "recipient" &&
      (anchor === undefined || !chain.has(anchor.message.msgId))
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

/** Whether the form lets the sender of `sent` send its act: by its role, or as the recipient of the message that set the form's fact. */
function senderPermitted(
  { by }: Form,
  { message, role }: Sent,
  anchor?: ReplayedAct,
) {
  return by.kind === "recipient"
    ? anchor?.message.recipient === message.author
    : by.roles.includes(role);
}

/** A message that replies into the instance belongs to it, whether or not it advanced the instance, so a later reply may name it. */
function joinInstance(progress: Progress, message: Message) {
  const instance = progress.instance;
  if (instance === undefined) {
    return progress;
  }
  const reference = message.replyToMsgId;
  const belongs =
    instance.acts[0]?.message.msgId === message.msgId ||
    (reference !== undefined && instance.members.has(reference));
  return belongs
    ? {
        ...progress,
        instance: {
          ...instance,
          members: new Map([...instance.members, [message.msgId, reference]]),
        },
      }
    : progress;
}

/** The refusal of an act that may not follow, naming the act its reply reference points at when that is known. */
function invalidTransition(
  progress: Progress,
  norm: Norm,
  message: Message,
  act: Act,
) {
  const preceding =
    message.replyToMsgId === undefined
      ? undefined
      : progress.known.get(message.replyToMsgId);
  const after = preceding === undefined ? "" : ` after ${preceding}`;
  return violation(
    `${act.performative} is not valid${after} for ${norm.name}.`,
  );
}

/** Whether the message's reply reference suits `form`: an opening may omit it, and a reference names a message of the conversation. */
function checkReference(
  progress: Progress,
  form: Form,
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
  return progress.known.has(replyToMsgId)
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
  { form, act }: FittedAct,
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
function applyAct(
  progress: Progress,
  entry: ReplayedAct & FittedAct,
): Progress {
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
    return anchor === undefined || !chain.has(anchor.message.msgId)
      ? undefined
      : anchor;
  }
  return [...instance.acts]
    .reverse()
    .find(
      (entry) =>
        chain.has(entry.message.msgId) &&
        entry.act.performative === reference.performative,
    );
}

/**
 * The form `norm` declares for `act`, once the act names that norm and its
 * fields fit the form: every required field stated, every stated field
 * declared, and each value of its field's type and within its bounds. The
 * refusal names every field at fault.
 */
function fitForm(norm: Norm, act: Act): Checked<Form> {
  const { performative, fields } = act;
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
    ? Either.right(form)
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

function structural(detail: string, field?: string): NormProblem {
  return { stage: "structural", reason: "rule-violation", detail, field };
}

function violation(detail: string, field?: string): NormProblem {
  return { stage: "protocol", reason: "rule-violation", detail, field };
}

function unavailable(detail: string): NormProblem {
  return { stage: "protocol", reason: "unresolved-evidence", detail };
}
