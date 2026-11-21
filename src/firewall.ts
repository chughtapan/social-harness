/**
 * @file One agent's message firewall. A message-policy file gives text rules;
 * a check has a decision provider judge whether a message breaks each rule
 * that applies to it, and decides what the agent may send or read and what
 * its caller saves.
 */

import { FileSystem } from "@effect/platform";
import { Clock, Config, Data, Effect, Exit, Schema, Struct } from "effect";
import { randomBytes } from "node:crypto";
import {
  type Answer,
  askProvider,
  type DecisionProvider,
  type Direction,
  jevDecisionProvider,
} from "./decision-provider.js";
import { AgentName, type Message } from "./messages.js";

const identifier = Schema.NonEmptyTrimmedString;

/** Why the firewall refused a message: it broke a rule, left one unsettled, or its check could not run. */
export type FirewallRefusalReason = Refusal["reason"] | "check-unavailable";

/**
 * One text rule: the prose a decision provider judges and the feedback it
 * gives the sender of a message it refuses. Validation requires nonempty
 * text without restricting its language. The message policy specification
 * defines who owns each rule and how edits are validated.
 */
export class TextRule extends Schema.Class<TextRule>("TextRule")({
  id: identifier,
  feedback: Schema.optional(Schema.NonEmptyString),
  text: Schema.NonEmptyString,
  applies: Schema.Literal("incoming", "outgoing", "both"),
}) {}

/**
 * What one completed check concluded, as its caller saves it, without message
 * content: whether the message the agent sent or received was `allowed` or
 * `refused`, and its peer. `time` is Unix milliseconds.
 * `decidedBy[].advice` contains the feedback of each rule that decided a
 * refused message.
 * `checkedRuleIds` lists the rules the check judged: a rule that does not
 * apply to the message's direction is not listed.
 */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The firewall owns this grammar, which the server stores and returns from read_firewall_decisions.
export const checkRecordSchema = Schema.Struct({
  checkId: Schema.NonEmptyString,
  direction: Schema.Literal("incoming", "outgoing"),
  decision: Schema.Literal("allowed", "refused"),
  time: Schema.NonNegativeInt,
  peer: AgentName,
  reason: Schema.Literal("eligible", "rule-violation", "unresolved-evidence"),
  decidedBy: Schema.Array(
    Schema.Struct({
      ruleId: Schema.NonEmptyString,
      advice: Schema.optional(Schema.NonEmptyString),
    }),
  ),
  checkedRuleIds: Schema.Array(Schema.NonEmptyString),
});
/** @useDeclaredType */
export type CheckRecord = typeof checkRecordSchema.Type;

/**
 * A message with the time this firewall checked it, in epoch milliseconds.
 * A message sent while the agent had no message policy has no check.
 */
export interface CheckedMessage {
  readonly message: Message;
  readonly checkedAt?: number;
}

/**
 * What a refusal says of the structure check behind it, as a host reads it in
 * a failed send: the norm the message was read as an act of, with the digest
 * of its document, the act, and the stage that refused it. A message the
 * structure check passed and a text rule refused has the stage `semantic`.
 * `explanation` and `field` are those of a problem the structure check found.
 */
export interface StructureDetail {
  readonly norm?: string;
  readonly digest?: string;
  readonly act?: string;
  readonly stage: "structural" | "protocol" | "semantic";
  readonly explanation?: string;
  readonly field?: string;
}

/**
 * Judges whether a message may follow the earlier messages of its
 * conversation at the time `now`, before the text rules do. A refusal gives
 * its explanation as `feedback`, the rule the decision names and its
 * diagnostics as `detail`. A pass gives the text rules that also apply to
 * this message, the `protocol` context the decision provider reads and the
 * `detail` a refusal by a text rule carries.
 */
export type StructureCheck = (
  message: Message,
  earlier: readonly CheckedMessage[],
  now: number,
) => Effect.Effect<
  | {
      readonly kind: "refused";
      readonly reason: Refusal["reason"];
      readonly ruleId: string;
      readonly feedback: string;
      readonly detail?: StructureDetail;
    }
  | {
      readonly kind: "passed";
      readonly textRules: readonly TextRule[];
      readonly protocol?: unknown;
      readonly detail?: StructureDetail;
    }
>;

/**
 * A message the agent may send or read. `record` is what the caller saves of
 * the decision; an agent without a message policy has none.
 */
interface Allowed {
  readonly kind: "allowed";
  readonly record?: CheckRecord;
}

/**
 * A message whose send fails, whichever agent sent it: one that breaks a
 * rule or leaves one unsettled, or one whose check could not run, which has
 * no record. `rule` and `detail` are those of a structure check.
 */
interface Refused {
  readonly kind: "refused";
  readonly checkId: string;
  readonly reason: FirewallRefusalReason;
  readonly rule?: string;
  readonly feedback: readonly string[];
  readonly detail?: StructureDetail;
  readonly record?: CheckRecord;
}

/** One agent's message firewall. */
export interface Firewall {
  /**
   * Checks a message the agent sends (`outgoing`) or one a peer wrote to it
   * (`incoming`), after the `earlier` messages of its conversation in order.
   */
  readonly check: (
    direction: Direction,
    message: Message,
    earlier: readonly CheckedMessage[],
  ) => Effect.Effect<Allowed | Refused>;
}

/** One check's subject: the message, whether its agent sends or receives it, and the time of the check. */
interface Checked {
  readonly message: Message;
  readonly direction: Direction;
  readonly now: number;
}

/** What a check that refuses its message concluded. */
interface Refusal extends Pick<CheckRecord, "decidedBy" | "checkedRuleIds"> {
  readonly reason: Exclude<CheckRecord["reason"], "eligible">;
  readonly rule?: string;
  readonly feedback: readonly string[];
  readonly detail?: StructureDetail;
}

/**
 * The firewall that applies a message policy, and allows every message
 * without one. At most `maximumConcurrentChecks` requests to the provider run
 * at once, four when the policy sets none.
 *
 * A check has the structure check judge its message first, with the earlier
 * messages; that check's refusal refuses the message. The text rules that
 * apply to the message's direction then judge it: the owner's rules and those
 * the structure check gives it. Each answer complies, violates or is unsure.
 * A violation refuses, and an unsure answer refuses as unresolved evidence.
 * A provider that gives no usable answer makes the check unavailable. A refusal of a message the structure
 * check passed carries that check's detail.
 */
export function makeFirewall(applies: {
  readonly policy?: MessagePolicy;
  /** Judges each message before the text rules, and gives the text rules that join them. */
  readonly structureCheck?: StructureCheck;
  /** The most earlier messages the provider reads: 256 when unset. */
  readonly historyLimit?: number;
}): Firewall {
  const { policy } = applies;
  if (policy === undefined) {
    return { check: () => Effect.succeed({ kind: "allowed" }) };
  }
  const permits = Effect.unsafeMakeSemaphore(
    policy.maximumConcurrentChecks ?? 4,
  );
  const check: Firewall["check"] = (direction, message, earlier) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const checked = { message, direction, now };
      const structure = yield* (
        applies.structureCheck?.(message, earlier, now) ??
          Effect.succeed(undefined)
      );
      if (structure?.kind === "refused") {
        const { reason, ruleId, feedback, detail } = structure;
        return refused(checked, {
          reason,
          rule: ruleId,
          feedback: [feedback],
          detail,
          decidedBy: [{ ruleId }],
          checkedRuleIds: [ruleId],
        });
      }
      const rules = [...policy.rules, ...(structure?.textRules ?? [])].filter(
        (rule) => rule.applies === "both" || rule.applies === direction,
      );
      return yield* askProvider(policy, rules, {
        ...checked,
        earlier,
        historyLimit: applies.historyLimit,
        protocol: structure?.protocol,
      }).pipe(
        Effect.map((answers) => conclude(checked, answers, structure?.detail)),
        Effect.catchTag("DecisionProviderError", () =>
          Effect.succeed(unavailable(structure?.detail)),
        ),
        markCheckActivity(direction),
        Effect.withSpan("assessMessage"),
        permits.withPermits(1),
      );
    });
  return { check };
}

/**
 * What a check concludes from the provider's answers. A violation refuses,
 * and an unsure answer refuses the message as unresolved evidence. Otherwise
 * the message is allowed. `detail` is what the structure check gave of the
 * message it passed.
 */
function conclude(
  checked: Checked,
  answers: ReadonlyArray<Answer<TextRule>>,
  detail?: StructureDetail,
): Allowed | Refused {
  const checkedRuleIds = answers.map(({ rule }) => rule.id);
  const violated = answers.filter((answer) => answer.violates);
  const deciding =
    violated.length === 0
      ? answers.filter((answer) => answer.unsure)
      : violated;
  if (deciding.length === 0) {
    return {
      kind: "allowed",
      record: recordOf(checked, mintCheckId(), {
        reason: "eligible",
        decidedBy: [],
        checkedRuleIds,
      }),
    };
  }
  const decidedBy = deciding.map(({ rule }) => ({
    ruleId: rule.id,
    advice: rule.feedback,
  }));
  return refused(checked, {
    reason: violated.length === 0 ? "unresolved-evidence" : "rule-violation",
    decidedBy,
    checkedRuleIds,
    feedback: decidedBy.flatMap(({ advice }) => advice ?? []),
    detail,
  });
}

/** The refusal of a message: its send fails. */
function refused(checked: Checked, refusal: Refusal): Refused {
  const checkId = mintCheckId();
  return {
    kind: "refused",
    checkId,
    ...Struct.pick(refusal, "reason", "rule", "feedback", "detail"),
    record: recordOf(checked, checkId, refusal),
  };
}

/** The refusal of a send whose check could not run. Nothing was decided, so nothing is recorded. */
function unavailable(detail?: StructureDetail): Refused {
  return {
    kind: "refused",
    checkId: mintCheckId(),
    reason: "check-unavailable",
    feedback: [],
    detail,
  };
}

/** The record of the decision a check applied to its message, with the other agent of that message as its peer. */
function recordOf(
  { message, direction, now }: Checked,
  checkId: string,
  concluded: Pick<CheckRecord, "reason" | "decidedBy" | "checkedRuleIds">,
): CheckRecord {
  return {
    checkId,
    direction,
    decision: concluded.reason === "eligible" ? "allowed" : "refused",
    time: now,
    peer: direction === "outgoing" ? message.recipient : message.author,
    ...Struct.pick(concluded, "reason", "decidedBy", "checkedRuleIds"),
  };
}

/** A check id correlates a check without granting lookup authority. */
function mintCheckId() {
  return `chk_${randomBytes(32).toString("hex")}`;
}

/** A message-policy file or the decision provider's key that cannot be loaded, and why. */
class MessagePolicyConfigurationError extends Data.TaggedError(
  "MessagePolicyConfigurationError",
)<{ readonly message: string }> {}

const unloadable = (message: string) =>
  new MessagePolicyConfigurationError({ message });

/**
 * A message-policy file. Omitted settings take defaults: an answer below a
 * probability of 0.8 is unsure, and one request to the provider may take 15
 * seconds. Text rules need a provider, and rule ids are unique. Unknown
 * properties are rejected, so a misspelled setting cannot silently weaken the
 * policy.
 */
const messagePolicyFile = Schema.Struct({
  rules: Schema.optionalWith(Schema.Array(TextRule), { default: () => [] }),
  decisionProvider: Schema.optional(
    Schema.Struct({ model: Schema.NonEmptyTrimmedString }),
  ),
  settings: Schema.optionalWith(
    Schema.Struct({
      minimumProbability: Schema.Number.pipe(Schema.between(0.5, 1)),
      timeoutMilliseconds: Schema.Positive.pipe(Schema.int()),
    }),
    {
      default: () => ({ minimumProbability: 0.8, timeoutMilliseconds: 15_000 }),
    },
  ),
  maximumConcurrentChecks: Schema.optional(
    Schema.Int.pipe(Schema.between(1, 32)),
  ),
}).pipe(
  Schema.filter(
    (policy) =>
      policy.decisionProvider !== undefined || policy.rules.length === 0,
    { message: () => "decisionProvider is required for text rules" },
  ),
  Schema.filter(
    (policy) =>
      new Set(policy.rules.map((rule) => rule.id)).size === policy.rules.length,
    { message: () => "text rule ids must be unique" },
  ),
);

/**
 * A message policy as a firewall applies it: the rules and settings of its
 * file, and the provider that judges text rules. A file that names no
 * `decisionProvider` gives none.
 */
export interface MessagePolicy
  extends Omit<typeof messagePolicyFile.Type, "decisionProvider"> {
  readonly provider?: DecisionProvider;
}

/**
 * Loads the message-policy file at `path`. A file that names a
 * `decisionProvider` gets Jev under that model, with the key the environment
 * variable `SHARNESS_DECISION_PROVIDER_KEY` holds, even without text rules of
 * its own: a structure check can add rules for it to judge. A file that
 * cannot be read or decoded fails with a message naming it.
 */
export const loadMessagePolicy = Effect.fn("loadMessagePolicy")(function* (
  path: string,
): Effect.fn.Return<
  MessagePolicy,
  MessagePolicyConfigurationError,
  FileSystem.FileSystem
> {
  const filesystem = yield* FileSystem.FileSystem;
  const { decisionProvider, ...policy } = yield* filesystem
    .readFileString(path)
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknown(Schema.parseJson(messagePolicyFile), {
          onExcessProperty: "error",
        }),
      ),
      Effect.mapError((error) =>
        unloadable(
          `The message policy file ${path} is unreadable or invalid: ${error.message}`,
        ),
      ),
    );
  if (decisionProvider === undefined) {
    return policy;
  }
  const apiKey = yield* Config.redacted(
    Config.nonEmptyString("SHARNESS_DECISION_PROVIDER_KEY"),
  ).pipe(
    Effect.mapError(() =>
      unloadable(
        `The message policy ${path} names a decisionProvider and SHARNESS_DECISION_PROVIDER_KEY does not hold its key`,
      ),
    ),
  );
  return {
    ...policy,
    provider: jevDecisionProvider({ ...decisionProvider, apiKey }),
  };
});

/** Pairs a pending and a settled span around one check, even when it fails or is cancelled. */
function markCheckActivity(direction: Direction) {
  return <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      activitySpan("retry.pending", { id: direction }).pipe(
        Effect.zipRight(restore(work)),
        Effect.onExit((exit) => {
          const outcome = Exit.isInterrupted(exit) ? "interrupted" : "failed";
          return activitySpan("retry.settled", {
            id: direction,
            outcome: Exit.isSuccess(exit) ? "checked" : outcome,
          });
        }),
      ),
    );
}

/** A span that marks one end of a firewall check. */
function activitySpan(
  name: string,
  attributes: Readonly<Record<string, string>>,
): Effect.Effect<void> {
  return Effect.withSpan(Effect.void, name, {
    captureStackTrace: false,
    attributes: { kind: "firewall-check", ...attributes },
  });
}
