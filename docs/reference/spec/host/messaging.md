---
title: Host messaging interface
description: Send messages and read conversations through the daemon.
read_when:
  - You are integrating an agent host with a daemon
  - You need send outcomes or request lifetime guarantees
---

The host runs the agent's model, tools and private context and decides what to
send. The daemon admits the host as its owner's agent, has the server agent's
firewall check each message, and orders and stores it. Hosts use MCP for this
contract.

## Recipients

The server agent names a client by its
[agent name](../identity/identity-and-attribution.md#agents). A [client](../modes.md#what-a-client-can-do)
names no recipient, because its only peer is the server agent.

The server agent can name only a client that has sent it a message. A name
that is not an agent name fails as an invalid argument, and any other name
fails with `unknown-client`. These failures create no message.

## Sending a message

The server agent's send supplies a recipient and text, and a client's
supplies text. Either may name the message it replies to as `replyToMsgId`.
An earlier message supplies no recipient for a call that omits one.

The daemon validates the input, resolves the recipient and has the server
agent's firewall check the message. A successful send means the daemon has
ordered the message and saved it for both members of the conversation. It
returns `msgId`, the message id, which a reply to the message gives as
`replyToMsgId`. Every call sends a new message, including a
call with the same input as an earlier one.

### Failed sends

A failed send created no message. Its failure has a `reason` and a message
written for the model to act on:

| `reason` | Reader | Meaning |
| --- | --- | --- |
| `unknown-client` | Server agent | The client it named has not written to it. `name` is the name it gave. |
| `violation`, `unsure`, `unavailable` | Server agent | Its firewall refused its message, for this [reason](../firewall.md#refused-messages). `checkId` is the check and `feedback` what does not fit the norm. |
| `refused` | Client | The server agent's firewall refused its message. `feedback` is what does not fit the norm. |
| `unavailable` | Client | The server could not check its message. The same send may succeed later. |
| `content-invalid` | Either | The text is longer than 32,768 bytes as JSON text. |

A client reads nothing else of a refusal, as
[refused messages](../firewall.md#refused-messages) states.
Invalid arguments, malformed text among them, fail before the call runs and
identify the field to correct. A corrected message is a new send with a new
check.

## Receiving entries

MCP inbox reads
follow the [receiving contract](./receiving.md), which owns
contents, ordering and replay.

## Reading conversations

The server agent lists the name of every client that has a stored message, in
`clients`, and reads its conversation with one of them. A client reads its
one conversation. A read returns `entries`, oldest first, at most 50 to a
page, each with its `message`. Pass `nextCursor` as `cursor`, with the same client, until it is
absent. A read returns messages as stored, without another firewall check,
and they stay the same across a restart.

## Request lifetime

Each request acts as one agent: the one its credential selects. A call is
interrupted when its request is aborted, and other requests continue. A
message that was stored stays stored.

## MCP projection

A tool call that fails returns a result marked as an error (`isError: true`).
Its text is the failure's message, written for the model to act on. Its
structured content gives the failure's fields, among them its `reason`.
Credentials, the provider's answers and internal causes stay inside the daemon. A
check id grants no approval, management or system-role authority.
