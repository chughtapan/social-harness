/**
 * @file The server agent's firewall. It checks every message of a
 * conversation when it is sent, whichever member sends it: the structure
 * check reads the message as an act of the server's norms, a
 * decision provider judges it against the text rules those norms give it,
 * and the check decides whether the message is sent and what its caller
 * saves.
 */

import { Clock, Effect, Schema, Struct } from "effect";
import { randomBytes } from "node:crypto";
import type { Norms, Role, TextRule } from "./norms/index.js";
import {
  type Answer,
  askProvider,
  type Candidate,
  type DecisionProvider,
} from "./decision-provider.js";
import { AgentName, type Message } from "./messages.js";

/**
 * What one completed check decided, as its caller saves it, without message
 * content: which member sent the message, the client of its conversation, and
 * whether it was `allowed` or `refused`. `checkedAt` is Unix milliseconds. A
 * refused message has the `reason` it was refused: a `violation` of a rule,
 * or an `unsure` answer to one. `refusedBy` names each rule that refused it,
 * with its feedback. `checkedRuleIds` lists the rules the check applied.
 */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The firewall owns this grammar, which the server stores and returns from read_firewall_decisions.
export const checkRecordSchema = Schema.Struct({
  checkId: Schema.NonEmptyString,
  sender: Schema.Literal("client", "server"),
  client: AgentName,
  decision: Schema.Literal("allowed", "refused"),
  checkedAt: Schema.NonNegativeInt,
  reason: Schema.optional(Schema.Literal("violation", "unsure")),
  refusedBy: Schema.Array(
    Schema.Struct({
      ruleId: Schema.NonEmptyString,
      feedback: Schema.optional(Schema.NonEmptyString),
    }),
  ),
  checkedRuleIds: Schema.Array(Schema.NonEmptyString),
});
/** @useDeclaredType */
export type CheckRecord = typeof checkRecordSchema.Type;

/** Why the firewall refused a message: it violated a rule, the provider was unsure of one, or its check was unavailable. */
export type RefusalReason = NonNullable<CheckRecord["reason"]> | "unavailable";

/**
 * A message with the time this firewall checked it, in Unix milliseconds. A
 * message sent while the server had no norms has no check.
 */
export interface CheckedMessage {
  readonly message: Message;
  readonly checkedAt?: number;
}

/**
 * A message that may be sent. `record` is what the caller saves of the
 * decision; a server without norms has none.
 */
interface Allowed {
  readonly kind: "allowed";
  readonly record?: CheckRecord;
}

/**
 * A message whose send fails, whichever member sent it: one that violates a
 * rule, one the provider is unsure of, or one whose check was unavailable,
 * which has no record. `feedback` is what its sender reads.
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
interface Refusal extends Pick<CheckRecord, "refusedBy" | "checkedRuleIds"> {
  readonly reason: NonNullable<CheckRecord["reason"]>;
  readonly feedback: readonly string[];
}

/**
 * The firewall of a server whose norms are `norms`. A server without norms
 * allows every message and records nothing.
 *
 * A check runs the norms' structure check on its message first, with the
 * earlier messages; that check's refusal refuses the message as a
 * violation. The `provider` then answers whether the message breaks each
 * text rule the structure check gave it. A violation refuses, and so does
 * an unsure answer. A provider that gives no usable answer, and rules
 * without a provider, make the check unavailable.
 */
export function makeFirewall(applies: {
  readonly norms?: Pick<Norms, "structureCheck">;
  readonly provider?: DecisionProvider;
  /** The most earlier messages the provider reads: 256 when unset. */
  readonly historyLimit?: number;
}): Firewall {
  const { norms, provider, historyLimit } = applies;
  if (norms === undefined) {
    return { check: () => Effect.succeed({ kind: "allowed" }) };
  }
  const permits = Effect.unsafeMakeSemaphore(
    provider?.maximumConcurrentChecks ?? 1,
  );
  const check: Firewall["check"] = (sender, message, earlier) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const candidate = { message, sender, now };
      const found = yield* Effect.sync(() =>
        norms.structureCheck(
          sentBy(sender, message),
          earlierSent(earlier, candidate),
          now,
        ),
      ).pipe(Effect.withSpan("structureCheck"));
      if (found.kind === "refused") {
        const { ruleId, feedback } = found;
        return refuse(candidate, {
          reason: "violation",
          feedback: [feedback],
          refusedBy: [{ ruleId }],
          checkedRuleIds: [ruleId],
        });
      }
      return yield* askProvider(
        found.textRules,
        candidate,
        {
          earlier: earlier.map((stored) => stored.message),
          historyLimit,
          instance: found.instance,
        },
        provider,
      ).pipe(
        Effect.map((answers) => decide(candidate, answers)),
        Effect.catchTag("DecisionProviderError", () =>
          Effect.succeed(checkUnavailable()),
        ),
        Effect.withSpan("judgeTextRules"),
        permits.withPermits(1),
      );
    });
  return { check };
}

/** A message `sender` sent, as the structure check reads it. */
function sentBy(sender: Role, message: Message, checkedAt?: number) {
  return {
    ...Struct.pick(message, "msgId", "replyToMsgId", "text"),
    sender,
    checkedAt,
  };
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
 * so does an unsure answer when no rule is violated. Otherwise the message
 * is allowed. The feedback of a refusal is the text of each rule that
 * refused it.
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
        refusedBy: [],
        checkedRuleIds,
      }),
    };
  }
  return refuse(candidate, {
    reason: violated.length === 0 ? "unsure" : "violation",
    refusedBy: refusing.map(({ rule }) => ({
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

/** The refusal of a message whose check was unavailable. No rule refused it, so nothing is recorded. */
function checkUnavailable(): Refused {
  return {
    kind: "refused",
    checkId: mintCheckId(),
    reason: "unavailable",
    feedback: [],
  };
}

/** The record of what a check decided for its candidate: refused when it has a reason, and allowed otherwise. It names the client of the message's conversation. */
function recordOf(
  { message, sender, now }: Candidate,
  checkId: string,
  decided: Pick<CheckRecord, "reason" | "refusedBy" | "checkedRuleIds">,
): CheckRecord {
  return {
    checkId,
    sender,
    client: sender === "client" ? message.author : message.recipient,
    decision: decided.reason === undefined ? "allowed" : "refused",
    checkedAt: now,
    ...Struct.pick(decided, "reason", "refusedBy", "checkedRuleIds"),
  };
}

/** A check id correlates a check without granting lookup authority. */
function mintCheckId() {
  return `chk_${randomBytes(32).toString("hex")}`;
}
