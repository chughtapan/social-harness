/**
 * @file The server agent's firewall. It checks every message of a
 * conversation when it is sent, whichever member sends it: the structure
 * check holds the message to the norms the server publishes, a decision
 * provider judges the text rules those norms give it, and the check decides
 * whether the message is sent and what its caller saves.
 */

import { Clock, Effect, Exit, Schema, Struct } from "effect";
import { randomBytes } from "node:crypto";
import { type Answer, askProvider, type Judge } from "./decision-provider.js";
import { AgentName, type Message, type Role } from "./messages.js";

/** Why the firewall refused a message: it broke a rule, left one unsettled, or its check could not run. */
export type FirewallRefusalReason = Refusal["reason"] | "check-unavailable";

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
 * What one completed check concluded, as its caller saves it, without message
 * content: which member sent the message, the client of its conversation, and
 * whether it was `allowed` or `refused`. `time` is Unix milliseconds.
 * `decidedBy` names each rule that decided a refused message, with its
 * feedback. `checkedRuleIds` lists the rules the check judged.
 */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The firewall owns this grammar, which the server stores and returns from read_firewall_decisions.
export const checkRecordSchema = Schema.Struct({
  checkId: Schema.NonEmptyString,
  sender: Schema.Literal("client", "server"),
  client: AgentName,
  decision: Schema.Literal("allowed", "refused"),
  time: Schema.NonNegativeInt,
  reason: Schema.Literal("eligible", "rule-violation", "unresolved-evidence"),
  decidedBy: Schema.Array(
    Schema.Struct({
      ruleId: Schema.NonEmptyString,
      feedback: Schema.optional(Schema.NonEmptyString),
    }),
  ),
  checkedRuleIds: Schema.Array(Schema.NonEmptyString),
});
/** @useDeclaredType */
export type CheckRecord = typeof checkRecordSchema.Type;

/**
 * A message with the time this firewall checked it, in epoch milliseconds.
 * A message sent while the server held no norms has no check.
 */
export interface CheckedMessage {
  readonly message: Message;
  readonly checkedAt?: number;
}

/**
 * Judges whether a message `sender` sends may follow the earlier messages of
 * its conversation at the time `now`, before the text rules do. A refusal
 * gives the rule it is recorded under and, as `feedback`, what does not fit.
 * A pass gives the text rules that judge this message and the `protocol`
 * context the decision provider reads.
 */
export type StructureCheck = (
  sender: Role,
  message: Message,
  earlier: readonly CheckedMessage[],
  now: number,
) => Effect.Effect<
  | {
      readonly kind: "refused";
      readonly reason: Refusal["reason"];
      readonly ruleId: string;
      readonly feedback: string;
    }
  | {
      readonly kind: "passed";
      readonly textRules: readonly TextRule[];
      readonly protocol?: unknown;
    }
>;

/**
 * A message that may be sent. `record` is what the caller saves of the
 * decision; a server that holds no norms has none.
 */
interface Allowed {
  readonly kind: "allowed";
  readonly record?: CheckRecord;
}

/**
 * A message whose send fails, whichever member sent it: one that breaks a
 * rule or leaves one unsettled, or one whose check could not run, which has
 * no record. `feedback` is what its sender reads.
 */
interface Refused {
  readonly kind: "refused";
  readonly checkId: string;
  readonly reason: FirewallRefusalReason;
  readonly feedback: readonly string[];
  readonly record?: CheckRecord;
}

/** The server agent's firewall. */
export interface Firewall {
  /**
   * Checks a message `sender` sends, after the `earlier` messages of its
   * conversation in order.
   */
  readonly check: (
    sender: Role,
    message: Message,
    earlier: readonly CheckedMessage[],
  ) => Effect.Effect<Allowed | Refused>;
}

/** One check's subject: the message, which member sends it, and the time of the check. */
interface Checked {
  readonly message: Message;
  readonly sender: Role;
  readonly now: number;
}

/** What a check that refuses its message concluded. */
interface Refusal extends Pick<CheckRecord, "decidedBy" | "checkedRuleIds"> {
  readonly reason: Exclude<CheckRecord["reason"], "eligible">;
  readonly feedback: readonly string[];
}

/**
 * The firewall of a server whose norms `structureCheck` holds messages to. A
 * server without norms allows every message and records nothing.
 *
 * A check has the structure check judge its message first, with the earlier
 * messages; that check's refusal refuses the message. The `judge` then
 * answers whether the message breaks each text rule the structure check gave
 * it: complies, violates or unsure. A violation refuses, and an unsure answer
 * refuses as unresolved evidence. A judge that gives no usable answer, and
 * rules without a judge, make the check unavailable.
 */
export function makeFirewall(applies: {
  readonly structureCheck?: StructureCheck;
  readonly judge?: Judge;
  /** The most earlier messages the provider reads: 256 when unset. */
  readonly historyLimit?: number;
}): Firewall {
  const { structureCheck, judge } = applies;
  if (structureCheck === undefined) {
    return { check: () => Effect.succeed({ kind: "allowed" }) };
  }
  const permits = Effect.unsafeMakeSemaphore(
    judge?.maximumConcurrentChecks ?? 1,
  );
  const check: Firewall["check"] = (sender, message, earlier) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const checked = { message, sender, now };
      const structure = yield* structureCheck(sender, message, earlier, now);
      if (structure.kind === "refused") {
        const { reason, ruleId, feedback } = structure;
        return refused(checked, {
          reason,
          feedback: [feedback],
          decidedBy: [{ ruleId }],
          checkedRuleIds: [ruleId],
        });
      }
      return yield* askProvider(
        structure.textRules,
        {
          ...checked,
          earlier,
          historyLimit: applies.historyLimit,
          protocol: structure.protocol,
        },
        judge,
      ).pipe(
        Effect.map((answers) => conclude(checked, answers)),
        Effect.catchTag("DecisionProviderError", () =>
          Effect.succeed(unavailable()),
        ),
        markCheckActivity(sender),
        Effect.withSpan("assessMessage"),
        permits.withPermits(1),
      );
    });
  return { check };
}

/**
 * What a check concludes from the provider's answers. A violation refuses,
 * and an unsure answer refuses the message as unresolved evidence. Otherwise
 * the message is allowed. The feedback of a refusal is the text of each
 * deciding rule.
 */
function conclude(
  checked: Checked,
  answers: ReadonlyArray<Answer<TextRule>>,
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
  return refused(checked, {
    reason: violated.length === 0 ? "unresolved-evidence" : "rule-violation",
    decidedBy: deciding.map(({ rule }) => ({
      ruleId: rule.id,
      feedback: rule.text,
    })),
    checkedRuleIds,
    feedback: deciding.map(({ rule }) => rule.text),
  });
}

/** The refusal of a message: its send fails. */
function refused(checked: Checked, refusal: Refusal): Refused {
  const checkId = mintCheckId();
  return {
    kind: "refused",
    checkId,
    ...Struct.pick(refusal, "reason", "feedback"),
    record: recordOf(checked, checkId, refusal),
  };
}

/** The refusal of a send whose check could not run. Nothing was decided, so nothing is recorded. */
function unavailable(): Refused {
  return {
    kind: "refused",
    checkId: mintCheckId(),
    reason: "check-unavailable",
    feedback: [],
  };
}

/** The record of the decision a check applied to its message, which names the client of the message's conversation. */
function recordOf(
  { message, sender, now }: Checked,
  checkId: string,
  concluded: Pick<CheckRecord, "reason" | "decidedBy" | "checkedRuleIds">,
): CheckRecord {
  return {
    checkId,
    sender,
    client: sender === "client" ? message.author : message.recipient,
    decision: concluded.reason === "eligible" ? "allowed" : "refused",
    time: now,
    ...Struct.pick(concluded, "reason", "decidedBy", "checkedRuleIds"),
  };
}

/** A check id correlates a check without granting lookup authority. */
function mintCheckId() {
  return `chk_${randomBytes(32).toString("hex")}`;
}

/** Pairs a pending and a settled span around one check, even when it fails or is cancelled. */
function markCheckActivity(sender: Role) {
  return <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.uninterruptibleMask((restore) =>
      activitySpan("retry.pending", { id: sender }).pipe(
        Effect.zipRight(restore(work)),
        Effect.onExit((exit) => {
          const outcome = Exit.isInterrupted(exit) ? "interrupted" : "failed";
          return activitySpan("retry.settled", {
            id: sender,
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
