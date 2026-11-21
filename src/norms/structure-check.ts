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
  type Delay,
  type EarlierAct,
  type Field,
  type Form,
  judgedFields,
  type Norm,
  type Relation,
  type Role,
  type Value,
} from "./norm.js";

/**
 * A message as the structure check reads it: its id, the id of the message
 * it replies to, which member sent it and its text. `checkedAt` is the time
 * it was checked, in milliseconds. An earlier message that was never checked
 * has none and is replayed as no act, and the message under check takes the
 * time given beside it.
 */
export interface Sent {
  readonly id: string;
  readonly replyTo?: string;
  readonly sender: Role;
  readonly text: string;
  readonly checkedAt?: number;
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
 * What the structure check finds of one message. A refusal gives the rule it
 * is recorded under and, as `feedback`, what does not fit. A pass gives the
 * text rules a decision provider judges the message against, and the
 * `instance` as the provider reads it with them: its norm, the act's
 * performative and fields, and the facts that are set.
 */
export type Finding =
  | {
      readonly kind: "refused";
      readonly reason: Problem["reason"];
      readonly ruleId: string;
      readonly feedback: string;
    }
  | {
      readonly kind: "passed";
      readonly textRules: readonly TextRule[];
      readonly instance?: unknown;
    };

/**
 * Why a message does not pass: the stage that failed, and the feedback its
 * sender reads. The `form` stage reads the message alone: its text is an act
 * of a published norm whose fields fit their form. The `protocol` stage
 * reads the conversation: the act is one its sender may send next.
 */
interface Problem {
  readonly stage: "form" | "protocol";
  readonly reason: "rule-violation" | "unresolved-evidence";
  readonly feedback: string;
}

/** What one step gives, or the problem that refuses the message there. */
type Step<Value> = Either.Either<Value, Problem>;

/** An act that fits its form: the act, the norm it is checked under and the form that norm declares for it. */
interface Fitted {
  readonly act: Act;
  readonly norm: Norm;
  readonly form: Form;
}

/**
 * Reads a text as an act and fits it to its form, under the norm of the
 * instance in progress or, when none is, the published norm the act names.
 * It also gives the norm the text was checked under, which names a refusal's
 * rule: a text that is no act is checked under the instance's norm, and
 * under none when no instance is in progress.
 */
type FitText = (
  text: string,
  instance?: Norm,
) => { readonly norm?: Norm; readonly fitted: Step<Fitted> };

/** An act of the instance, with the message that states it and the time that message was checked. */
type SentAct = Fitted & Sent & { readonly checkedAt: number };

/**
 * What replaying a conversation finds. `stored` gives the performative of
 * each earlier message, which a reply may name. `instance` is the instance
 * in progress: its norm, the act that set each fact that is set, how many
 * acts of each performative were sent, its acts in order, and its `thread`:
 * the reply reference of every message that belongs to it.
 */
interface Progress {
  readonly stored: ReadonlyMap<string, string | undefined>;
  readonly instance?: {
    readonly norm: Norm;
    readonly facts: ReadonlyMap<string, SentAct>;
    readonly timesSent: ReadonlyMap<string, number>;
    readonly acts: readonly SentAct[];
    readonly thread: ReadonlyMap<string, string | undefined>;
  };
}

type Instance = NonNullable<Progress["instance"]>;

/**
 * The structure check of a server that publishes `norms` and reads each
 * message's text with `readAct`. It checks `sent` at the time `now`, after
 * the `earlier` messages of its conversation: it replays them to find the
 * instance in progress, then reads the message as an act of that instance
 * or, when none is, of the norm it names. An act that fits passes with a
 * text rule for each described field it states. Any other message is refused
 * under a rule named for the norm it was checked under and the stage that
 * failed. Without norms every message passes.
 */
export function structureCheck(
  norms: readonly Norm[],
  readAct: (text: string) => Either.Either<Act, string>,
): (sent: Sent, earlier: readonly Sent[], now: number) => Finding {
  const fit: FitText = (text, instance) => {
    const read = Either.mapLeft(readAct(text), formProblem);
    const named = Either.getOrUndefined(read)?.norm;
    const norm = instance ?? norms.find(({ name }) => name === named);
    return { norm, fitted: Either.flatMap(read, (act) => fitForm(act, norm)) };
  };
  return (sent, earlier, now) => {
    if (norms.length === 0) {
      return { kind: "passed", textRules: [] };
    }
    const progress = replay(fit, earlier);
    const { norm, checked } = checkMessage(progress, fit, {
      ...sent,
      checkedAt: now,
    });
    return Either.match(checked, {
      onLeft: (problem) => refusal(problem, norm),
      onRight: (act) => pass(progress, act),
    });
  };
}

/**
 * The refusal of a message with `problem`, under a rule named for `norm`,
 * the norm the message was checked under, and the stage that failed. A
 * message checked under no norm has the word `norm` there.
 */
function refusal(problem: Problem, norm?: Norm): Finding {
  return {
    kind: "refused",
    reason: problem.reason,
    ruleId: `${norm?.name ?? "norm"}-${problem.stage}`,
    feedback: problem.feedback,
  };
}

/**
 * The pass of an act that fits: a text rule for each judged field the act
 * states, which requires the field's text to be what its description says,
 * and what the decision provider reads of the instance.
 */
function pass(progress: Progress, { act, norm, form }: Fitted): Finding {
  return {
    kind: "passed",
    textRules: judgedFields(form).flatMap(({ name, subject, description }) =>
      Object.hasOwn(act.fields, name)
        ? [
            {
              id: `${norm.name}.${act.performative}.${name}`,
              text: `${subject} must contain only what its description says: ${description}`,
            },
          ]
        : [],
    ),
    instance: {
      norm: norm.name,
      digest: norm.digest,
      description: norm.description,
      performative: act.performative,
      fields: form.fields,
      facts: [...(progress.instance?.facts.keys() ?? [])],
    },
  };
}

/**
 * Replays a conversation's earlier messages in order under the published
 * norms. Only a checked message that passes every step at the time of its
 * check has its effects. Every message is stored afterwards, and may join
 * the thread of the instance in progress.
 */
function replay(fit: FitText, earlier: readonly Sent[]): Progress {
  const stored = new Map<string, string | undefined>();
  let progress: Progress = { stored };
  for (const { checkedAt, ...message } of earlier) {
    const act =
      checkedAt === undefined
        ? undefined
        : Either.getOrUndefined(
            checkMessage(progress, fit, { ...message, checkedAt }).checked,
          );
    if (act !== undefined && checkedAt !== undefined) {
      progress = applyAct(progress, { ...act, ...message, checkedAt });
    }
    progress = joinThread(progress, message);
    stored.set(message.id, act?.act.performative);
  }
  return progress;
}

/**
 * Checks one message by every step: whether its text is an act that fits its
 * form, and whether the conversation's progress permits that act at the time
 * of its check. It also gives the norm the message was checked under.
 */
function checkMessage(
  progress: Progress,
  fit: FitText,
  sent: Sent & { readonly checkedAt: number },
) {
  const { norm, fitted } = fit(sent.text, progress.instance?.norm);
  return {
    norm,
    checked: Either.flatMap(fitted, (act) =>
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
  sent: Sent & { readonly checkedAt: number },
): Either.Either<void, Problem> {
  const { act, norm, form } = fitted;
  const invalid = mayNotFollow(progress, norm, sent, act);
  const notTheirs = protocolProblem(
    `${act.performative} is not the ${sent.sender}'s to send in ${norm.name}.`,
  );
  return Either.gen(function* () {
    yield* checkReference(progress, form, sent);
    const instance = progress.instance;
    if (instance === undefined) {
      const starting = permitsSender(form, sent)
        ? Either.void
        : Either.left(notTheirs);
      return yield* form.starts ? starting : Either.left(invalid);
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
    if (!permitsSender(form, sent, anchor)) {
      return yield* Either.left(notTheirs);
    }
    if (!isEnabled(form, instance)) {
      return yield* Either.left(invalid);
    }
    if (form.delay !== undefined) {
      yield* checkDelay(instance, form.delay, sent.checkedAt, invalid);
    }
    return yield* checkRelations(instance, fitted, chain, invalid);
  });
}

/**
 * Whether the form lets the sender of `sent` send its act: by its role, or
 * as the recipient of the message that set the form's fact. A conversation
 * has two members, so that recipient is the member who did not send it.
 */
function permitsSender({ by }: Form, { sender }: Sent, anchor?: SentAct) {
  return by.kind === "recipient"
    ? anchor !== undefined && anchor.sender !== sender
    : by.roles.includes(sender);
}

/** A message that replies into the instance's thread belongs to it, whether or not it advanced the instance, so a later reply may name it. */
function joinThread(
  progress: Progress,
  { id, replyTo }: Pick<Sent, "id" | "replyTo">,
) {
  const instance = progress.instance;
  if (instance === undefined) {
    return progress;
  }
  const belongs =
    instance.acts[0]?.id === id ||
    (replyTo !== undefined && instance.thread.has(replyTo));
  return belongs
    ? {
        ...progress,
        instance: {
          ...instance,
          thread: new Map([...instance.thread, [id, replyTo]]),
        },
      }
    : progress;
}

/** The refusal of an act that may not follow, naming the act its reply reference points at when that is known. */
function mayNotFollow(
  progress: Progress,
  norm: Norm,
  { replyTo }: Sent,
  act: Act,
) {
  const preceding =
    replyTo === undefined ? undefined : progress.stored.get(replyTo);
  const after = preceding === undefined ? "" : ` after ${preceding}`;
  return protocolProblem(
    `${act.performative} is not valid${after} for ${norm.name}.`,
  );
}

/** Whether the message's reply reference suits `form`: an act that starts an instance may omit it, and a reference names a stored message of the conversation. */
function checkReference(
  progress: Progress,
  form: Form,
  { replyTo }: Sent,
): Either.Either<void, Problem> {
  if (replyTo === undefined) {
    return form.starts
      ? Either.void
      : Either.left(
          protocolProblem("replyToMsgId is required for a continuation act."),
        );
  }
  return progress.stored.has(replyTo)
    ? Either.void
    : Either.left(
        protocolProblem(
          "replyToMsgId does not identify a preceding message in this conversation.",
        ),
      );
}

/** Whether an act's delay has passed at `now`. A delay whose fact is not set, or was set by an act without the delay's field, settles nothing. */
function checkDelay(
  instance: Instance,
  delay: Delay,
  now: number,
  invalid: Problem,
): Either.Either<void, Problem> {
  const permittedAt = delayedUntil(instance, delay);
  if (permittedAt === undefined) {
    return Either.left(
      unresolved("The declared delay has no retained numeric anchor."),
    );
  }
  return now < permittedAt ? Either.left(invalid) : Either.void;
}

/** Whether every relation of the act's form is satisfied by the earlier acts the reply chain contains. */
function checkRelations(
  instance: Instance,
  { form, act }: Fitted,
  chain: ReadonlySet<string>,
  invalid: Problem,
): Either.Either<void, Problem> {
  return Either.gen(function* () {
    for (const { field, operator, source } of form.relations) {
      const expected = yield* sourceValue(instance, source, chain, invalid);
      const actual = act.fields[field];
      if (actual === undefined || !isSatisfied(operator, actual, expected)) {
        return yield* Either.left(invalid);
      }
    }
  });
}

/** A conversation's progress once `sent`, an act that passed, has its effects: it ends the instance, or starts one when none is in progress and then clears and sets facts. */
function applyAct(progress: Progress, sent: SentAct): Progress {
  const { norm, form } = sent;
  if (form.ends) {
    return { ...progress, instance: undefined };
  }
  const prior: Instance = progress.instance ?? {
    norm,
    facts: new Map(),
    timesSent: new Map(),
    acts: [],
    thread: new Map(),
  };
  const facts = new Map(prior.facts);
  const timesSent = new Map(prior.timesSent);
  for (const fact of form.clears) {
    facts.delete(fact);
  }
  for (const fact of form.sets) {
    facts.set(fact, sent);
  }
  timesSent.set(form.performative, (timesSent.get(form.performative) ?? 0) + 1);
  return {
    ...progress,
    instance: { ...prior, facts, timesSent, acts: [...prior.acts, sent] },
  };
}

/** Whether every fact the form needs is set and fewer acts of it than its limit were sent. */
function isEnabled(form: Form, instance: Instance) {
  const facts = form.when.every((fact) => instance.facts.has(fact));
  const count =
    form.max === undefined ||
    (instance.timesSent.get(form.performative) ?? 0) < form.max;
  return facts && count;
}

/** The messages a reply reference leads back through, within the instance's thread. */
function replyChain(instance: Instance, reference?: string) {
  const chain = new Set<string>();
  let current = reference;
  while (
    current !== undefined &&
    !chain.has(current) &&
    instance.thread.has(current)
  ) {
    chain.add(current);
    current = instance.thread.get(current);
  }
  return chain;
}

/** The time a delay has passed: the check of the act that set its fact, plus the seconds that act's field gives. */
function delayedUntil(instance: Instance, delay: Delay) {
  const anchor = instance.facts.get(delay.fact);
  const seconds = anchor?.act.fields[delay.field];
  return anchor !== undefined && typeof seconds === "number"
    ? anchor.checkedAt + seconds * 1000
    : undefined;
}

/** Whether `actual` is what a relation's operator requires against `expected`. */
function isSatisfied(
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

/** The value a relation compares its field with: the source's field of the earlier act it names, which the reply chain must contain. An optional field the act left out settles nothing. */
function sourceValue(
  instance: Instance,
  source: Relation["source"],
  chain: ReadonlySet<string>,
  invalid: Problem,
): Step<Value> {
  const fields = earlierAct(instance, source.act, chain)?.act.fields;
  if (fields === undefined) {
    return Either.left(invalid);
  }
  const value = fields[source.field];
  return value === undefined
    ? Either.left(
        unresolved(
          "A declared relation needs an earlier field that is missing.",
        ),
      )
    : Either.right(value);
}

/** The earlier act `earlier` names, when the reply chain contains it: the one that set a fact, or the latest of a performative. */
function earlierAct(
  instance: Instance,
  earlier: EarlierAct,
  chain: ReadonlySet<string>,
) {
  if (earlier.kind === "fact") {
    const anchor = instance.facts.get(earlier.fact);
    return anchor === undefined || !chain.has(anchor.id) ? undefined : anchor;
  }
  return [...instance.acts]
    .reverse()
    .find(
      (sent) =>
        chain.has(sent.id) && sent.act.performative === earlier.performative,
    );
}

/**
 * `act` with the norm it is checked under and the form that norm declares
 * for it, once the server publishes a norm for it, the act names that norm
 * and its fields fit the form: every required field stated, every stated
 * field declared, and each value of its field's type and within its bounds.
 * The refusal names every field at fault.
 */
function fitForm(act: Act, norm?: Norm): Step<Fitted> {
  const { performative, fields } = act;
  if (norm === undefined) {
    return Either.left(
      formProblem("The act's norm is not one this server publishes."),
    );
  }
  const form = norm.forms.find((entry) => entry.performative === performative);
  if (norm.name !== act.norm) {
    return Either.left(
      protocolProblem(
        `${performative} is not valid for the active norm ${norm.name}.`,
      ),
    );
  }
  if (form === undefined) {
    return Either.left(
      formProblem(`${performative} is not a valid act in ${act.norm}.`),
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
    : Either.left(formProblem(failures.join(" ")));
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

/** Whether `value` lies between two inclusive bounds, where each is set. */
function within(value: number, minimum?: number, maximum?: number) {
  return (
    (minimum === undefined || value >= minimum) &&
    (maximum === undefined || value <= maximum)
  );
}

/** The problem of a message whose text is no act that fits its form. */
function formProblem(feedback: string): Problem {
  return { stage: "form", reason: "rule-violation", feedback };
}

/** The problem of an act its sender may not send next. */
function protocolProblem(feedback: string): Problem {
  return { stage: "protocol", reason: "rule-violation", feedback };
}

/** The problem of an act whose turn rule the stored conversation cannot settle. */
function unresolved(feedback: string): Problem {
  return { stage: "protocol", reason: "unresolved-evidence", feedback };
}
