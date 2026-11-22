/**
 * @file The server agent's firewall. It checks every message of a
 * conversation when it is sent, whichever member sends it: the structure
 * check reads the message as an act of the server's norms, a
 * decision provider judges it against the text rules those norms give it,
 * and the check decides whether the message is sent and what its caller
 * saves.
 */

import { Clock, Effect, Option, Schema, Struct } from "effect";
import { randomBytes } from "node:crypto";
import type { Norms, Role } from "./norms/index.js";
import { askProvider, type DecisionProvider } from "./decision-provider.js";
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

/**
 * A message with which member sent it and the time this firewall checked it,
 * in Unix milliseconds. A message sent while the server had no norms has no
 * check.
 */
export interface CheckedMessage {
  readonly message: Message;
  readonly sender: Role;
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
 * which has no record because no rule refused it. `feedback` is what its
 * sender reads.
 */
interface Refused {
  readonly kind: "refused";
  readonly checkId: string;
  readonly reason: NonNullable<CheckRecord["reason"]> | "unavailable";
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

/**
 * The firewall of a server whose norms are `norms`. A server without norms
 * allows every message and records nothing.
 *
 * A check runs the norms' structure check on its message first, with the
 * earlier messages; that check's refusal refuses the message as a
 * violation. The `provider` then answers whether the message breaks each
 * text rule the structure check gave it. A violation refuses, and so does
 * an unsure answer when no rule is violated; the feedback of a refusal is the
 * text of each rule that refused it. A provider that gives no usable answer,
 * and rules without a provider, make the check unavailable.
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
  const check = Effect.fnUntraced(function* (
    sender: Role,
    message: Message,
    earlier: readonly CheckedMessage[],
  ): Effect.fn.Return<Allowed | Refused> {
    const now = yield* Clock.currentTimeMillis;
    const checkId = `chk_${randomBytes(32).toString("hex")}`;
    /** The record of this check's decision. It names the client of the message's conversation. */
    const record = (
      decided: Pick<CheckRecord, "reason" | "refusedBy" | "checkedRuleIds">,
    ): CheckRecord => ({
      checkId,
      sender,
      client: sender === "client" ? message.author : message.recipient,
      decision: decided.reason === undefined ? "allowed" : "refused",
      checkedAt: now,
      ...decided,
    });
    const found = yield* Effect.sync(() =>
      norms.structureCheck(
        sentBy(sender, message),
        earlier.map((stored) =>
          sentBy(stored.sender, stored.message, stored.checkedAt),
        ),
        now,
      ),
    ).pipe(Effect.withSpan("structureCheck"));
    if (found.kind === "refused") {
      return {
        kind: "refused",
        checkId,
        reason: "violation",
        feedback: [found.feedback],
        record: record({
          reason: "violation",
          refusedBy: [{ ruleId: found.ruleId }],
          checkedRuleIds: [found.ruleId],
        }),
      };
    }
    const answers = yield* askProvider(
      found.textRules,
      { message, sender, now },
      {
        earlier: earlier.map((stored) => stored.message),
        historyLimit,
        instance: found.instance,
      },
      provider,
    ).pipe(
      Effect.option,
      Effect.withSpan("judgeTextRules"),
      permits.withPermits(1),
    );
    if (Option.isNone(answers)) {
      return {
        kind: "refused",
        checkId,
        reason: "unavailable",
        feedback: [],
      };
    }
    const checkedRuleIds = answers.value.map(({ rule }) => rule.id);
    const violated = answers.value.filter((answer) => answer.violates);
    const refusing =
      violated.length === 0
        ? answers.value.filter((answer) => answer.unsure)
        : violated;
    if (refusing.length === 0) {
      return {
        kind: "allowed",
        record: record({ refusedBy: [], checkedRuleIds }),
      };
    }
    const reason = violated.length === 0 ? "unsure" : "violation";
    return {
      kind: "refused",
      checkId,
      reason,
      feedback: refusing.map(({ rule }) => rule.text),
      record: record({
        reason,
        refusedBy: refusing.map(({ rule }) => ({
          ruleId: rule.id,
          feedback: rule.text,
        })),
        checkedRuleIds,
      }),
    };
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
