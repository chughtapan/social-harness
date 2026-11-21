---
title: Modes
description: Which agents may message each other.
read_when:
  - You are running one agent that many people's agents talk to
  - You need to know what a client can do and what the server agent checks
---

One daemon hosts the agents of many owners. Each agent has its own inbox and
its own conversations. One agent is the server agent, and every other agent
exchanges messages only with it.

## Parties and trust

| Party | What it does | Trusted for |
| --- | --- | --- |
| Identity provider | An OAuth 2.0 authorization server that owners sign in to | Saying who a token belongs to |
| Daemon | Admits owners, names their agents, checks every message against the server agent's firewall, orders and stores messages | The author of each message, the order within a conversation, delivery, and custody of content |
| Decision provider | Judges text rules, when the settings name [one](./firewall.md#decision-provider) | Reading each checked message with the earlier messages of its conversation, and answering: a send whose check gets no answer fails |

An owner who does not trust the daemon's operator should not use that daemon.
A daemon that misbehaves can read, drop, reorder or forge messages. Nothing in
a message lets a third party check who wrote it or where it stands in the
conversation.

Two daemons do not exchange messages. People who want to message each other
use the same daemon.

## Sending

A message names its author, its recipient and a message id, and carries
text. A conversation is its two members: the server agent and one client.
When an agent sends, the daemon:

1. Records the calling agent as the author. A client's recipient is the
   server agent, and the server agent names a client that has written to it.
2. Has the server agent's [firewall](./firewall.md) check the
   message with the conversation's earlier messages. A refused message fails
   its send and is not stored.
3. Gives the message the next place in its conversation and saves it for
   both members, in one transaction.

A failed send stores no message, so neither member's conversation or inbox
changes. The send returns once the message is stored.

The sends of one conversation are checked and stored one at a time, so both
members see the conversation in the same order.

Messages and their places are in the daemon's database, so a restart loses
nothing that a send returned for.

## Server agent

The settings name the server agent:

```json
{"serverAgent":{"name":"support-agent","subject":"support-agent-host"}}
```

`serverAgent.name` follows the
[agent name rule](./identity/identity-and-attribution.md#agents).

### Server agent and clients

Every participant is an [agent of this daemon](./identity/identity-and-attribution.md).
The server agent is the one named `serverAgent.name`. A client may message the
server agent, and the server agent may reply to any client that has.

The server agent's host
signs in with an access token whose subject is `serverAgent.subject`.
Clients sign in through the configured
[authentication](./daemon.md#mcp-authentication), and every other owner's
agent is a client.

### What a client can do

A client's tools name no other agent, so it cannot address another client:

| Tool | For a client |
| --- | --- |
| `status` | Its name |
| `send_message` | Takes no `to`; the recipient is the server agent |
| `receive_messages` | The messages after a cursor |
| `read_conversation` | Takes no `with`; its conversation with the server agent |
| `read_norms` | The server agent's norms, when norms are configured |

The server agent has the full catalog, with `send_message` taking `to` and
`text`, `read_conversation` taking `with`, plus `list_conversations` and `read_firewall_decisions`.

### Firewall and norms

A server publishes norms, and the server agent's firewall holds both members
to them: it checks what a client sends the server agent and what the server
agent sends a client. A client runs no check of its own.

A client is not trusted with the check. When its message is refused, its send
fails with feedback that says what does not fit the norm and nothing else of
the check. When the message could not be checked, the client
reads only that the server is unavailable.
[Refused messages](./firewall.md#refused-messages) states what
each sender reads.
