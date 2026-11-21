/**
 * @file The server agent's firewall. It checks every message of a
 * conversation when it is sent, whichever member sends it: the structure
 * check reads the message as an act of the norms the server publishes, a
 * decision provider judges it against the text rules those norms give it,
 * and the check decides whether the message is sent and what its caller
 * saves.
 */

import { Clock, Effect, Exit, Schema, Struct } from "effect";
import { randomBytes } from "node:crypto";
import type { Norms, Role, TextRule } from "./norms/index.js";
import {
  type Answer,
  askProvider,
  type Candidate,
  type Judge,
} from "./decision-provider.js";
import { AgentName, type Message } from "./messages.js";

/**
 * What one completed check decided, as its caller saves it, without message
 * content: which member sent the message, the client of its conversation, and
 * whether it was `allowed` or `refused`. `checkedAt` is Unix milliseconds. A
 * refused message has the `reason` it was refused: it broke a rule, or left
 * one unsettled. `decidedBy` names each rule that refused it, with its
 * feedback. `checkedRuleIds` lists the rules the check applied.
 */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The firewall owns this grammar, which the server stores and returns from read_firewall_decisions.
export const checkRecordSchema = Schema.Struct({
  checkId: Schema.NonEmptyString,
  sender: Schema.Literal("client", "server"),
  client: AgentName,
  decision: Schema.Literal("allowed", "refused"),
  checkedAt: Schema.NonNegativeInt,
  reason: Schema.optional(
    Schema.Literal("rule-violation", "unresolved-evidence"),
  ),
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

/** Why the firewall refused a message: it broke a rule, left one unsettled, or its check could not run. */
export type RefusalReason =
  | NonNullable<CheckRecord["reason"]>
  | "check-unavailable";

/**
 * A message with the time this firewall checked it, in Unix milliseconds. A
 * message sent while the server published no norms has no check.
 */
export interface CheckedMessage {
  readonly message: Message;
  readonly checkedAt?: number;
}

/**
 * A message that may be sent. `record` is what the caller saves of the
 * decision; a server that publishes no norms has none.
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
  readonly reason: RefusalReason;
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

/** What a check that refuses its message decided: why, the rules that refused it, and the feedback its sender reads. */
interface Refusal extends Pick<CheckRecord, "decidedBy" | "checkedRuleIds"> {
  readonly reason: NonNullable<CheckRecord["reason"]>;
  readonly feedback: readonly string[];
}

/**
 * The firewall of a server that publishes `norms`. A server without norms
 * allows every message and records nothing.
 *
 * A check runs the norms' structure check on its message first, with the
 * earlier messages; that check's refusal refuses the message. The `judge`
 * then answers whether the message breaks each text rule the structure check
 * gave it: complies, violates or unsure. A violation refuses, and an unsure
 * answer refuses as unresolved evidence. A judge that gives no usable
 * answer, and rules without a judge, make the check unavailable.
 */
export function makeFirewall(applies: {
  readonly norms?: Pick<Norms, "structureCheck">;
  readonly judge?: Judge;
  /** The most earlier messages the provider reads: 256 when unset. */
  readonly historyLimit?: number;
}): Firewall {
  const { norms, judge, historyLimit } = applies;
  if (norms === undefined) {
    return { check: () => Effect.succeed({ kind: "allowed" }) };
  }
  const permits = Effect.unsafeMakeSemaphore(
    judge?.maximumConcurrentChecks ?? 1,
  );
  const check: Firewall["check"] = (sender, message, earlier) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const candidate = {
        message,
        sender,
        now,
        earlier: earlier.map((stored) => stored.message),
        historyLimit,
      };
      const found = yield* Effect.sync(() =>
        norms.structureCheck(
          sentBy(sender, message),
          earlierSent(earlier, candidate),
          now,
        ),
      ).pipe(Effect.withSpan("structureCheck"));
      if (found.kind === "refused") {
        const { reason, ruleId, feedback } = found;
        return refuse(candidate, {
          reason,
          feedback: [feedback],
          decidedBy: [{ ruleId }],
          checkedRuleIds: [ruleId],
        });
      }
      return yield* askProvider(
        found.textRules,
        { ...candidate, instance: found.instance },
        judge,
      ).pipe(
        Effect.map((answers) => decide(candidate, answers)),
        Effect.catchTag("DecisionProviderError", () =>
          Effect.succeed(checkUnavailable()),
        ),
        markCheckActivity(sender),
        Effect.withSpan("judgeTextRules"),
        permits.withPermits(1),
      );
    });
  return { check };
}

/** A message `sender` sent, as the structure check reads it. */
function sentBy(
  sender: Role,
  { msgId, replyToMsgId, text }: Message,
  checkedAt?: number,
) {
  return { id: msgId, replyTo: replyToMsgId, sender, text, checkedAt };
}

/**
 * The earlier messages as the structure check reads them. A conversation has
 * two members, so an earlier message has the candidate's sender when the
 * same agent wrote it and the other role otherwise.
 */
function earlierSent(earlier: readonly CheckedMessage[], candidate: Candidate) {
  const { sender } = candidate;
  const other = sender === "client" ? "server" : "client";
  return earlier.map(({ message, checkedAt }) =>
    sentBy(
      message.author === candidate.message.author ? sender : other,
      message,
      checkedAt,
    ),
  );
}

/**
 * What a check decides from the provider's answers. A violation refuses, and
 * an unsure answer refuses the message as unresolved evidence. Otherwise the
 * message is allowed. The feedback of a refusal is the text of each rule
 * that refused it.
 */
function decide(
  candidate: Candidate,
  answers: ReadonlyArray<Answer<TextRule>>,
): Allowed | Refused {
  const checkedRuleIds = answers.map(({ rule }) => rule.id);
  const violated = answers.filter((answer) => answer.violates);
  const refusing =
    violated.length === 0
      ? answers.filter((answer) => answer.unsure)
      : violated;
  if (refusing.length === 0) {
    return {
      kind: "allowed",
      record: recordOf(candidate, mintCheckId(), {
        decidedBy: [],
        checkedRuleIds,
      }),
    };
  }
  return refuse(candidate, {
    reason: violated.length === 0 ? "unresolved-evidence" : "rule-violation",
    decidedBy: refusing.map(({ rule }) => ({
      ruleId: rule.id,
      feedback: rule.text,
    })),
    checkedRuleIds,
    feedback: refusing.map(({ rule }) => rule.text),
  });
}

/** The decision that refuses the candidate, with its record. */
function refuse(candidate: Candidate, refusal: Refusal): Refused {
  const checkId = mintCheckId();
  return {
    kind: "refused",
    checkId,
    ...Struct.pick(refusal, "reason", "feedback"),
    record: recordOf(candidate, checkId, refusal),
  };
}

/** The refusal of a send whose check could not run. Nothing was decided, so nothing is recorded. */
function checkUnavailable(): Refused {
  return {
    kind: "refused",
    checkId: mintCheckId(),
    reason: "check-unavailable",
    feedback: [],
  };
}

/** The record of what a check decided for its candidate: refused when it has a reason, and allowed otherwise. It names the client of the message's conversation. */
function recordOf(
  { message, sender, now }: Candidate,
  checkId: string,
  decided: Pick<CheckRecord, "reason" | "decidedBy" | "checkedRuleIds">,
): CheckRecord {
  return {
    checkId,
    sender,
    client: sender === "client" ? message.author : message.recipient,
    decision: decided.reason === undefined ? "allowed" : "refused",
    checkedAt: now,
    ...Struct.pick(decided, "reason", "decidedBy", "checkedRuleIds"),
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
