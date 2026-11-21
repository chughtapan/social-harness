---
title: Host messaging interface
description: Send messages and receive deliveries through the daemon.
read_when:
  - You are integrating an agent host with a daemon
  - You need send outcomes or connection lifetime guarantees
---

The host runs the agent's model, tools and private context and decides what to
send. The daemon admits the host as its owner's agent, resolves the agents a
message names, applies policy, orders and stores messages, and preserves
accepted work. Hosts use MCP for this contract.

## Destinations

The server agent names a client by its
[agent name](../identity/identity-and-attribution.md#agents). A [client](../modes.md#what-a-client-can-do)
names no destination, because its only peer is the server agent.

The server agent can name only a client that has sent it a message. A name
that is not an agent name fails as an invalid argument, and any other name
fails with `unknown-agent`. These failures create no message.

## Sending a message

The server agent's send supplies a destination and text; a client's supplies text. Session focus and prior messages cannot supply an
omitted destination.

The daemon validates input, resolves the recipient and checks the message
against the server agent's message policy.
A successful result for a message means the daemon has ordered it and saved
it for every member of the conversation. Every new call, including identical input, creates a fresh
invocation.

Every successful send returns `id`, a message id.

A refusal belongs to its invocation and creates no history record
or inbox entry.

### Failed sends

A failed send created no message. Its failure has a `reason` and a message
written for the model to act on:

| `reason` | Reader | Meaning |
| --- | --- | --- |
| `unknown-agent` | Server agent | The client it named has not written to it. `name` is the name it gave. |
| `firewall-refused` | Server agent | Its firewall refused its message. `refusal` is the reason, `checkId` the check and `feedback` the deciding rules' feedback. A refusal under a norm adds `rule` and `detail`. |
| `refused` | Client | The server agent's firewall refused its message. `feedback` is the deciding rules' feedback. |
| `unavailable` | Client | The server could not check its message. The same send may succeed later. |
| `content-invalid` | Either | The text is malformed or longer than 32,768 bytes as JSON text. |

A client reads nothing else of a check, as
[refused messages](../firewall/message-policy.md#refused-messages) states.
Invalid arguments fail before the call runs and identify the field to
correct. A corrected message is a new send with a new check.

Repeating a successful send creates another message. Cancelling a call does
not remove a message it already stored.

## Receiving inbox entries

MCP inbox reads
follow the [receiving contract](./receiving.md), which owns
contents, ordering and replay.

## Reading history

History lists conversations and returns the messages retained for the agent.
The content stays the same across restart.

Listing returns every client's name in `clients`. History returns `records`, oldest
first, at most 50 to a page. Pass `nextCursor` as
`cursor` with the same client until absent.

An invalid history page returns no messages. Reading history does not
authorize a send.

## Connection lifetime

An MCP connection represents one agent: the one its credential selects.

Closing a connection stops its active receiver and in-flight requests. Canceling
one request leaves others active. Accepted sends and stored inbox entries survive.

## MCP projection

A tool call that fails returns a result marked as an error (`isError: true`).
Its text is the failure's message, written for the model to act on. Its
structured content holds the failure's fields, among them its `reason`.
Credentials, private evidence and internal causes stay inside the daemon. A
check id grants no approval, management or system-role authority.
