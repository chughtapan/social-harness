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
  type EarlierAct,
  type Field,
  type FieldValue,
  type Form,
  judgedFields,
  type Norm,
  type Relation,
  type Role,
} from "./norm.js";

/**
 * A message as the structure check reads it: its message id, the id of the
 * message it replies to, which member sent it and its text. `checkedAt` is
 * the time it was checked, in milliseconds. An earlier message that was
 * never checked has none and is replayed as no act, and the message under
 * check takes the time given beside it.
 */
export interface Sent {
  readonly msgId: string;
  readonly replyToMsgId?: string;
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
 * of one of the server's norms whose fields fit their form. The `protocol`
 * stage reads the conversation: the act is one its sender may send next.
 */
interface Problem {
  readonly stage: "form" | "protocol";
  readonly feedback: string;
}

/** What one step gives, or the problem that refuses the message there. */
type Step<A> = Either.Either<A, Problem>;

/** An act that fits its form: the act, the norm it is checked under and the form that norm declares for it. */
interface Fitted {
  readonly act: Act;
  readonly norm: Norm;
  readonly form: Form;
}

/**
 * Reads a text as an act and fits it to its form, under the norm of the
 * instance in progress or, when none is, the norm the act names.
 * It also gives the norm the text was checked under, which names a refusal's
 * rule: a text that is no act is checked under the instance's norm, and
 * under none when no instance is in progress.
 */
type FitText = (
  text: string,
  instanceNorm?: Norm,
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
 * The structure check of a server whose norms are `norms`, which reads each
 * message's text with `readAct`. It checks `sent` at the time `now`, after
 * the `earlier` messages of its conversation: it replays them to find the
 * instance in progress, then reads the message as an act of that instance
 * or, when none is, of the norm it names. An act that fits passes with a
 * text rule for each described field it states. Any other message is refused
 * under a rule named for the norm it was checked under and the stage that
 * failed.
 */
export function structureCheck(
  norms: readonly Norm[],
  readAct: (text: string) => Either.Either<Act, string>,
): (sent: Sent, earlier: readonly Sent[], now: number) => Finding {
  const fit: FitText = (text, instanceNorm) => {
    const read = Either.mapLeft(readAct(text), formProblem);
    const named = Either.getOrUndefined(read)?.norm;
    const norm = instanceNorm ?? norms.find(({ name }) => name === named);
    return { norm, fitted: Either.flatMap(read, (act) => fitForm(act, norm)) };
  };
  return (sent, earlier, now) => {
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
 * Replays a conversation's earlier messages in order under the server's
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
    stored.set(message.msgId, act?.act.performative);
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
 * breaks a relation gets the one refusal of an act out of turn.
 */
function checkProtocol(
  progress: Progress,
  fitted: Fitted,
  sent: Sent & { readonly checkedAt: number },
): Either.Either<void, Problem> {
  const { act, norm, form } = fitted;
  const outOfTurn = turnProblem(progress, norm, sent, act);
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
      return yield* form.starts ? starting : Either.left(outOfTurn);
    }
    if (form.starts) {
      return yield* Either.left(outOfTurn);
    }
    const chain = replyChain(instance, sent.replyToMsgId);
    if (chain.size === 0) {
      return yield* Either.left(outOfTurn);
    }
    const setter =
      form.by.kind === "recipient"
        ? instance.facts.get(form.by.fact)
        : undefined;
    if (
      form.by.kind === "recipient" &&
      (setter === undefined || !chain.has(setter.msgId))
    ) {
      return yield* Either.left(outOfTurn);
    }
    if (!permitsSender(form, sent, setter)) {
      return yield* Either.left(notTheirs);
    }
    return isEnabled(form, instance) &&
      !isDelayed(instance, form, sent.checkedAt) &&
      satisfiesRelations(instance, fitted, chain)
      ? undefined
      : yield* Either.left(outOfTurn);
  });
}

/**
 * Whether the form lets the sender of `sent` send its act: by its role, or
 * as the recipient of `setter`, the message that set the form's fact. A
 * conversation has two members, so that recipient is the member who did not
 * send it.
 */
function permitsSender({ by }: Form, { sender }: Sent, setter?: SentAct) {
  return by.kind === "recipient"
    ? setter !== undefined && setter.sender !== sender
    : by.roles.includes(sender);
}

/** A message that replies into the instance's thread belongs to it, whether or not it advanced the instance, so a later reply may name it. */
function joinThread(
  progress: Progress,
  { msgId, replyToMsgId }: Pick<Sent, "msgId" | "replyToMsgId">,
) {
  const instance = progress.instance;
  if (instance === undefined) {
    return progress;
  }
  const belongs =
    instance.acts[0]?.msgId === msgId ||
    (replyToMsgId !== undefined && instance.thread.has(replyToMsgId));
  return belongs
    ? {
        ...progress,
        instance: {
          ...instance,
          thread: new Map([...instance.thread, [msgId, replyToMsgId]]),
        },
      }
    : progress;
}

/** The problem of an act out of turn, naming the act its reply reference points at when that message is one. */
function turnProblem(
  progress: Progress,
  norm: Norm,
  { replyToMsgId }: Sent,
  act: Act,
) {
  const earlier =
    replyToMsgId === undefined ? undefined : progress.stored.get(replyToMsgId);
  const after = earlier === undefined ? "" : ` after ${earlier}`;
  return protocolProblem(
    `${act.performative} is not valid${after} for ${norm.name}.`,
  );
}

/** Whether the message's reply reference suits `form`: an act that starts an instance may omit it, and a reference names a stored message of the conversation. */
function checkReference(
  progress: Progress,
  form: Form,
  { replyToMsgId }: Sent,
): Either.Either<void, Problem> {
  if (replyToMsgId === undefined) {
    return form.starts
      ? Either.void
      : Either.left(
          protocolProblem("replyToMsgId is required for a continuation act."),
        );
  }
  return progress.stored.has(replyToMsgId)
    ? Either.void
    : Either.left(
        protocolProblem(
          "replyToMsgId does not identify an earlier message in this conversation.",
        ),
      );
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
function replyChain(instance: Instance, replyToMsgId?: string) {
  const chain = new Set<string>();
  let current = replyToMsgId;
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

/**
 * Whether the form's delay has yet to pass at `now`: the act that set the
 * delay's fact was checked fewer seconds ago than its field says. A
 * well-formed norm always gives that act and that number.
 */
function isDelayed(instance: Instance, { delay }: Form, now: number) {
  if (delay === undefined) {
    return false;
  }
  const setter = instance.facts.get(delay.fact);
  const seconds = setter?.act.fields[delay.secondsField];
  return (
    setter === undefined ||
    typeof seconds !== "number" ||
    now < setter.checkedAt + seconds * 1000
  );
}

/**
 * Whether the act satisfies every relation of its form: it states the
 * relation's field, the reply chain contains the earlier act the source
 * names, and the two fields compare as the operator requires.
 */
function satisfiesRelations(
  instance: Instance,
  { form, act }: Fitted,
  chain: ReadonlySet<string>,
) {
  return form.relations.every(({ field, operator, source }) => {
    const actual = act.fields[field];
    const expected = earlierAct(instance, source.act, chain)?.act.fields[
      source.field
    ];
    return (
      actual !== undefined &&
      expected !== undefined &&
      isSatisfied(operator, actual, expected)
    );
  });
}

/** Whether `actual` is what a relation's operator requires against `expected`. */
function isSatisfied(
  operator: Relation["operator"],
  actual: FieldValue,
  expected: FieldValue,
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

/** The earlier act `earlier` names, when the reply chain contains it: the one that set a fact, or the latest of a performative. */
function earlierAct(
  instance: Instance,
  earlier: EarlierAct,
  chain: ReadonlySet<string>,
) {
  if (earlier.kind === "fact") {
    const setter = instance.facts.get(earlier.fact);
    return setter === undefined || !chain.has(setter.msgId)
      ? undefined
      : setter;
  }
  return [...instance.acts]
    .reverse()
    .find(
      (sent) =>
        chain.has(sent.msgId) && sent.act.performative === earlier.performative,
    );
}

/**
 * `act` with the norm it is checked under and the form that norm declares
 * for it, once the server has a norm for it, the act names that norm
 * and its fields fit the form: every required field stated, every stated
 * field declared, and each value of its field's type and within its bounds.
 * The refusal names every field at fault.
 */
function fitForm(act: Act, norm?: Norm): Step<Fitted> {
  const { performative, fields } = act;
  if (norm === undefined) {
    return Either.left(
      formProblem("The act's norm is not one of this server's norms."),
    );
  }
  const form = norm.forms.find((entry) => entry.performative === performative);
  if (norm.name !== act.norm) {
    return Either.left(
      protocolProblem(
        `${performative} is not valid for ${norm.name}, the norm in progress.`,
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
function accepts(field: Field, value: FieldValue): boolean {
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
  return { stage: "form", feedback };
}

/** The problem of an act its sender may not send next. */
function protocolProblem(feedback: string): Problem {
  return { stage: "protocol", feedback };
}
