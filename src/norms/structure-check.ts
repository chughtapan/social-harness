/**
 * @file The structure check, which decides whether a message is an act its
 * sender may send next.
 *
 * It keeps no state between checks. Each check replays the conversation's
 * earlier messages to rebuild the instance in progress, then checks the new
 * message against it. The parser that turns text into an act is passed in,
 * so this file knows nothing about syntax.
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
 * A message as the structure check takes it. `checkedAt` is the time it was
 * checked, in Unix milliseconds.
 *
 * An earlier message without `checkedAt` was stored while the server had no
 * norms, and replay treats it as not being an act. The message under check
 * has no `checkedAt` either: the caller passes the current time separately.
 */
export interface Sent {
  readonly msgId: string;
  readonly replyToMsgId?: string;
  readonly sender: Role;
  readonly text: string;
  readonly checkedAt?: number;
}

/**
 * A rule about a field's text, written in prose for the decision provider.
 * If the rule refuses a message, the sender is shown the same text as
 * feedback, so the text says what the field must contain.
 */
export interface TextRule {
  readonly id: string;
  readonly text: string;
}

/**
 * The result of checking one message.
 *
 * A refusal has the id of the rule to record and `feedback` for the sender.
 * A pass has the text rules for the decision provider and `instance`, a
 * summary the provider is shown: the norm's name, digest and description,
 * the act's performative, the form's field declarations, and the facts that
 * were set before this act.
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
 * The reason a message is refused: the stage that failed and the feedback
 * for the sender.
 *
 * The `form` stage checks the message itself: the text is an act of one of
 * the server's norms and its fields match the form. The `protocol` stage
 * checks the message against the conversation: the sender may send this act
 * next. An act that names a different norm from the instance in progress is
 * a protocol problem.
 */
interface Problem {
  readonly stage: "form" | "protocol";
  readonly feedback: string;
}

/** The result of one step: its value, or the problem that refuses the message. */
type Step<A> = Either.Either<A, Problem>;

/** An act that passed the form stage, with its norm and its form. */
interface Fitted {
  readonly act: Act;
  readonly norm: Norm;
  readonly form: Form;
}

/**
 * Parses text as an act and runs the form stage on it.
 *
 * The norm used is the norm of the instance in progress, or the norm the act
 * names when no instance is in progress. The returned `norm` is the one the
 * text was checked under, which goes into the rule id of a refusal. It is
 * undefined when no instance is in progress and the text is not an act, or
 * names a norm the server does not have.
 */
type FitText = (
  text: string,
  instanceNorm?: Norm,
) => { readonly norm?: Norm; readonly fitted: Step<Fitted> };

/** An act that passed, with the message that carried it and the time of its check. */
type SentAct = Fitted & Sent & { readonly checkedAt: number };

/**
 * The state of a conversation after replay.
 *
 * `stored` maps each earlier message id to its performative, or to undefined
 * if the message was not an act that passed. `instance` is the instance in
 * progress, if any. Its `facts` map each set fact to the act that set it.
 * `timesSent` counts the acts sent per performative. `acts` holds the acts
 * that passed, in order. `thread` maps each message that belongs to the
 * instance to the message it replies to.
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
 * Makes the structure check for a server's norms. `readAct` parses a
 * message's text into an act.
 *
 * The returned function checks `sent` at the time `now`. It replays the
 * `earlier` messages to find the instance in progress, then checks `sent` as
 * an act of that instance, or of the norm it names when there is none.
 *
 * A valid act passes, with one text rule for each judged field it
 * includes. Anything else is refused. The refusal's rule id combines the
 * norm the message was checked under and the stage that failed.
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
 * Builds a refusal. Its rule id is the norm's name and the failed stage,
 * such as `booking-protocol`. If the message was checked under no norm, the
 * id uses the word `norm` in place of a name.
 */
function refusal(problem: Problem, norm?: Norm): Finding {
  return {
    kind: "refused",
    ruleId: `${norm?.name ?? "norm"}-${problem.stage}`,
    feedback: problem.feedback,
  };
}

/**
 * Builds a pass. It has one text rule for each judged field the act
 * includes, requiring the field to contain only what its description says,
 * and the instance summary for the decision provider.
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
 * Replays the earlier messages in order to rebuild the conversation's state.
 *
 * Each message that has a check time is checked again as of that time. Only
 * a message that passes changes the instance's facts, counts and acts.
 * Every message is added to `stored`, and joins the thread if it replies
 * into the instance.
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
 * Runs both stages on one message: the form stage, then the protocol stage.
 * Also returns the norm the message was checked under.
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
 * Runs the protocol stage: whether the conversation's state allows this act
 * now.
 *
 * Several different failures give the same "not valid" feedback: replying
 * outside the instance, arriving before the delay has passed, and breaking
 * a relation.
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
 * Whether the form allows this sender. With roles, the sender's role must
 * be listed. With a recipient rule, the sender must be the recipient of
 * `setter`, the message that set the fact. A conversation has two members,
 * so the recipient is whoever did not send `setter`.
 */
function permitsSender({ by }: Form, { sender }: Sent, setter?: SentAct) {
  return by.kind === "recipient"
    ? setter !== undefined && setter.sender !== sender
    : by.roles.includes(sender);
}

/** Adds a message to the instance's thread if it started the instance or replies to a message in the thread. This applies even to a message that did not pass, so a later message can reply to it. */
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

/** Builds the "not valid" problem for an act sent out of turn. If the act replies to an earlier act, the feedback names that act's performative. */
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

/** Checks the reply reference. Only an act that starts an instance may omit it, and a reference must name a stored message of this conversation. */
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

/** Applies an act that passed. An ending act removes the instance. Otherwise the act starts an instance if none is in progress, then clears and sets facts and counts itself. */
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

/** Whether every fact in the form's `when` is set and the form's `max` has not been reached. */
function isEnabled(form: Form, instance: Instance) {
  const facts = form.when.every((fact) => instance.facts.has(fact));
  const count =
    form.max === undefined ||
    (instance.timesSent.get(form.performative) ?? 0) < form.max;
  return facts && count;
}

/** The ids reached by following reply references back from `replyToMsgId`, staying within the instance's thread. */
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
 * Whether the form's delay has not yet passed at `now`. The delay is
 * measured from the check time of the act that set the delay's fact, and
 * its length comes from that act's seconds field. A well-formed norm
 * guarantees that act and that number exist.
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
 * Whether the act satisfies every relation of its form. For each relation,
 * the act must include the field, the earlier act must be in the reply
 * chain, and the two values must satisfy the operator.
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

/** Whether `actual` satisfies the operator against `expected`: equal to it, one of its items, or a subset of its items. */
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

/** Finds the earlier act a relation refers to: the act that set a fact, or the latest act with a performative. Returns undefined if it is not in the reply chain. */
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
 * Runs the form stage on an act. The act passes when the server has the
 * norm, the act names that norm, the norm declares the performative, and
 * the fields match: every required field is present, every field present is
 * declared, and every value has the right type and is within bounds. A
 * refusal lists every field that is wrong.
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

/** Whether `value` has the field's type and is within its bounds. A string's length is counted in code points. */
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

/** Whether `value` is within the inclusive bounds. A missing bound is not checked. */
function within(value: number, minimum?: number, maximum?: number) {
  return (
    (minimum === undefined || value >= minimum) &&
    (maximum === undefined || value <= maximum)
  );
}

function formProblem(feedback: string): Problem {
  return { stage: "form", feedback };
}

function protocolProblem(feedback: string): Problem {
  return { stage: "protocol", feedback };
}
