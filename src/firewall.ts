/**
 * @file The firewall, which checks every message against the server's norms
 * before it is sent. A norm says which structured messages, called acts, the
 * two members of a conversation (the client and the server agent) may send
 * each other, and in what order.
 *
 * A check has two steps. The structure check decides whether the message is
 * a valid act at this point in the conversation. The decision provider then
 * judges the act's text fields against their rules.
 */

import { Clock, Effect, Option, Schema, Struct } from "effect";
import { randomBytes } from "node:crypto";
import type { Norms, Role } from "./norms/index.js";
import { askProvider, type DecisionProvider } from "./decision-provider.js";
import { AgentName, type Message } from "./messages.js";

/**
 * The saved record of one check. It holds no message content.
 *
 * `sender` is the member that sent the message and `client` names its
 * conversation. `checkedAt` is in Unix milliseconds. A refused message has a
 * `reason`: it broke a rule (`violation`) or the provider could not settle a
 * rule (`unsure`). `refusedBy` lists the rules that refused it.
 * `checkedRuleIds` lists the text rules the provider judged, or the
 * structure check's rule when that refused the message.
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
/**
 * A decoded check record.
 * @useDeclaredType
 */
export type CheckRecord = typeof checkRecordSchema.Type;

/**
 * An earlier message of a conversation, with the member that sent it and the
 * time it was checked, in Unix milliseconds. `checkedAt` is absent for a
 * message stored while the server had no norms.
 */
export interface CheckedMessage {
  readonly message: Message;
  readonly sender: Role;
  readonly checkedAt?: number;
}

/**
 * The message may be sent. The caller saves `record`. There is no record
 * when the server has no norms.
 */
interface Allowed {
  readonly kind: "allowed";
  readonly record?: CheckRecord;
}

/**
 * The message must not be sent. `feedback` is the text for its sender.
 *
 * The reason is `violation`, `unsure` or `unavailable`. An unavailable check
 * has no record, because no rule refused the message.
 */
interface Refused {
  readonly kind: "refused";
  readonly checkId: string;
  readonly reason: NonNullable<CheckRecord["reason"]> | "unavailable";
  readonly feedback: readonly string[];
  readonly record?: CheckRecord;
}

/** The firewall: one `check` operation. */
export interface Firewall {
  /**
   * Checks a message that `sender` wants to send. `earlier` holds the
   * conversation's stored messages, oldest first.
   */
  readonly check: (
    sender: Role,
    message: Message,
    earlier: readonly CheckedMessage[],
  ) => Effect.Effect<Allowed | Refused>;
}

/**
 * Makes the firewall for a server with the given norms. Without norms, the
 * firewall allows every message and records nothing.
 *
 * A check runs the structure check first. If that refuses the message, the
 * reason is `violation`. Otherwise the provider answers each text rule the
 * structure check returned. Any violated rule refuses the message. If no
 * rule is violated but the provider is unsure about one, that also refuses
 * it. The feedback is the structure check's explanation, or the text of
 * each text rule that refused the message.
 *
 * The check is `unavailable` when the provider gives no usable answer, or
 * when there are text rules but no provider.
 */
export function makeFirewall(applies: {
  readonly norms?: Pick<Norms, "structureCheck">;
  readonly provider?: DecisionProvider;
  /** How many earlier messages the provider is shown. Defaults to 256. */
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

/** Converts a message to the shape the structure check takes. */
function sentBy(sender: Role, message: Message, checkedAt?: number) {
  return {
    ...Struct.pick(message, "msgId", "replyToMsgId", "text"),
    sender,
    checkedAt,
  };
}
