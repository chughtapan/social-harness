/** @file Agent names, message ids and messages, with the rules each must satisfy. */

import { Data, Effect, Schema } from "effect";
import { randomBytes } from "node:crypto";

/** An agent's name. The server agent's name comes from the settings. A client's name is derived from its owner. */
export const AgentName = Schema.String.pipe(
  Schema.minLength(3),
  Schema.maxLength(32),
  Schema.pattern(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  Schema.brand("AgentName"),
  Schema.annotations({
    identifier: "AgentName",
    description:
      "an agent name: 3 to 32 lowercase letters, digits or single hyphens, starting and ending with a letter or digit",
  }),
);
/** A string that passed {@link AgentName}. */
export type AgentName = typeof AgentName.Type;

/** A message could not be created, usually because its text is not valid Unicode or is too long. */
class CommunicationError extends Data.TaggedError("CommunicationError")<{
  readonly reason: "content-invalid";
}> {
  override get message(): string {
    return "send failed: the message content is invalid";
  }
}

/**
 * A message id: `msg_` followed by 32 random bytes in base64url, which is 43
 * characters. The last character encodes only four bits, which limits which
 * characters it can be.
 */
export const MsgId = Schema.String.pipe(
  Schema.pattern(/^msg_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u),
  Schema.brand("MsgId"),
  Schema.annotations({
    identifier: "MsgId",
    description: "MsgId: msg_ then 43 base64url characters",
  }),
);
/**
 * A string that passed {@link MsgId}.
 * @useDeclaredType
 */
export type MsgId = typeof MsgId.Type;

/** The largest size of a message's text, measured in bytes of its JSON encoding. */
const maximumTextBytes = 32_768;

/** A string with no unpaired surrogates, which UTF-8 cannot encode. */
export const wellFormedString = Schema.String.pipe(
  Schema.filter((value) => !/\p{Surrogate}/u.test(value), {
    identifier: "WellFormedUnicodeString",
  }),
);

/**
 * One message from its author to its recipient. A message never changes
 * after it is created. `replyToMsgId` is the id of the message it replies to,
 * if the sender gave one.
 */
const messageSchema = Schema.Struct({
  author: AgentName,
  recipient: AgentName,
  msgId: MsgId,
  replyToMsgId: Schema.optional(MsgId),
  text: wellFormedString.pipe(
    Schema.filter(
      (text) => Buffer.byteLength(JSON.stringify(text)) <= maximumTextBytes,
    ),
  ),
}).pipe(
  Schema.filter(({ author, recipient }) => recipient !== author),
  Schema.annotations({ identifier: "Message" }),
);
/**
 * A value that passed the message schema.
 * @useDeclaredType
 */
export type Message = typeof messageSchema.Type;

/** The message schema, with `create` to make a new message. */
export const Message = Object.assign(messageSchema, {
  /** Makes a message with a new id. Fails if the message is not valid, for example when its text is too long. */
  create: (input: Omit<Message, "msgId">) =>
    Effect.suspend(() =>
      Schema.decode(messageSchema)({
        ...input,
        msgId: `msg_${randomBytes(32).toString("base64url")}`,
      }),
    ).pipe(
      Effect.catchTag(
        "ParseError",
        () => new CommunicationError({ reason: "content-invalid" }),
      ),
      Effect.withSpan("Message.create"),
    ),
});
