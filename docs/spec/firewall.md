---
title: Message firewall
description: How the server agent's firewall enforces the server's norms on every message.
read_when:
  - You need to know what a firewall decision allows or refuses
  - You need to know what the sender of a refused message reads
---

The message firewall checks every message of the server agent's conversations
when it is sent: what a client sends the server agent, and what the server
agent sends a client. It enforces the server's [norms](./norms.md). It
receives a message, which member sent it and the earlier
messages of its conversation. It returns a decision, the rules that refused
a refused message, and the feedback its sender reads.

The firewall owns its checks. The daemon supplies the message and its
conversation, applies the decision to the send, and saves a record of the
check, which survives a restart.

A server without norms has no firewall, and `sharnessd` checks no message.
Only the server agent has a firewall. The
host owns models, tools and the agent's private context.

## One check

A check has two parts, in order:

1. The structure check reads the message as an act of one of the server's
   norms. It
   passes an act that fits its form and is its sender's to send next in the
   conversation's protocol, and refuses any other message.
2. The decision provider judges an act that passed against its text rules:
   one rule for each
   [described string or list field](./norms.md#text-rules) the act
   states.

A continuation replies to a message in the thread of the instance in
progress. A reply to a message of an ended instance cannot change or end a
later instance in the same conversation.

## Decisions

A check allows its message or refuses it, whichever member sent it, and a
refused message's send fails. The answers to an act's text rules combine in
priority order:

1. A violation refuses, with the reason `violation`.
2. An unsure answer refuses, with the reason `unsure`.
3. Otherwise, allow.

Every text rule of the act needs an answer, and a compliant answer cannot
erase another rule's violation. A check without a valid answer for every
rule is unavailable: its message is refused with the reason `unavailable`,
and it leaves no record, because no rule refused the message. A cancelled
check produces no decision. A check cannot alter its message.

### Provider answers

A text rule requires one field to contain only what its description says.
The norm's author writes the description, and the firewall derives the rule
from it.

For each rule, the decision provider answers one question about the message:
does it break the rule? The answer is `compliant` or `violation`, with a
probability for each. The provider is told which member sent the message and
judges it as that member's.

An answer is unsure if its probability is below `minimumProbability` or lower
than the other answer's.

Invalid output or provider failure makes the check unavailable. Accepting a
description promises no accuracy of its checks in any language.

## Refused messages

A refused message is not stored, its recipient never reads it, and its send
fails. The daemon neither
changes a message nor sends a substitute or a later approval. An allowed
message reaches its recipient's host unchanged.

The firewall derives the feedback of every refusal from the norm documents,
which name no feedback of their own:

| Refused by | Feedback |
| --- | --- |
| Structure check | What in the act does not fit the norm: its form, its sender or its place in the protocol. |
| Text rule | The rule: the field's name and the description it must fit. |

A client is not trusted with the check itself, so what a failed send says
depends on who sent it:

| Sender | Reads |
| --- | --- |
| Server agent | The reason (`violation`, `unsure` or `unavailable`), the check id and the feedback. The check's [record](#decision-records) names the rules that refused it. |
| Client | The feedback. When the check was unavailable, only that the server is unavailable and to try again later. |

A client's failure says nothing else: no check id and no word of which
kind of refusal it was. Neither failure carries credentials or the
provider's answers.
[Failed sends](./messaging.md#failed-sends) gives the fields of each
failure. Every member reads the norm documents whole with `read_norms`, so
feedback tells a client nothing it could not read there.

## What a check reads

A check receives its message and the earlier messages of the conversation
once. It applies to that message and those earlier messages as captured,
without a second check when later messages arrive. An allowed message is
stored with the recipient, text and message id that were checked.

The decision provider is a service outside the daemon. Each check that has a
text rule sends it the message, the names of both agents, the rules, the
norm's description with the act's form and the facts that are set, and the
history window below.

### History window

The decision provider reads the earlier messages in conversation order,
without the message under check. The daemon's `historyLimit` setting limits
them to the latest 256 by default, configurable from 1 to 1024. A check uses
the conversation of its message; other conversations and host private context
are excluded. The window also has at most 2 MiB of messages, the latest that
fit. `earlierHistoryOmitted` tells the provider that earlier messages were
left out, and refuses nothing. The structure check separately receives every
earlier message with the time of the firewall's check of it, outside this
window.

A description that needs other conversations, older messages or instructions
the owner gave elsewhere cannot be judged from what a check reads.

## Decision provider

The settings file's `decisionProvider` names the provider that judges text
rules:

| Property | Requirement/default |
| --- | --- |
| `model` | Required: the Jev model. Its key is the `SHARNESS_DECISION_PROVIDER_KEY` environment variable. |
| `minimumProbability` | From 0.5 to 1, default 0.8: the probability below which an answer is unsure. |
| `timeoutMilliseconds` | Default 15000: the time all of one check's requests to the provider may take together. |
| `maximumConcurrentChecks` | From 1 to 32, default 4: how many checks ask the provider at once. |

Norms that describe a string or list field need `decisionProvider`, and the daemon
refuses to start without it. Without `decisionProvider`, no provider or key
is used. A check asks the provider again twice after a failure that may pass,
such as a rate limit, and is unavailable when no attempt answers within the
time limit.

## Decision records

Each completed check leaves one record. An unavailable or cancelled check
leaves none, and neither does a send that fails before its check, such as one
to an unknown client. `read_firewall_decisions` returns the hundred latest
records since the time `since`, in Unix milliseconds, newest first. A record
has no message content, message id or provider answer.

| Field | Meaning |
| --- | --- |
| `checkId` | Identifies the check. |
| `sender` | Which member sent the message: `client` or `server`. |
| `client` | The client of the message's conversation. A client's refused first message leaves a record and no conversation. |
| `decision` | `allowed` or `refused`. |
| `reason` | Why a refused message was refused: `violation` or `unsure`. An allowed message has none. |
| `checkedAt` | When the check ran, in Unix milliseconds. |
| `checkedRuleIds` | The rules the check applied. |
| `refusedBy` | The rules that refused the message, each with its `feedback`. An allowed message has none. A text rule is its norm, performative and field: `office-hours.request.topic`. A structure check's rule is the name of the norm the message was checked under, then the stage that refused, `form` or `protocol`: `office-hours-protocol`. Its feedback is not saved. |

| Reason | Rules in `refusedBy` |
| --- | --- |
| `violation` | The violated text rules, or the structure check's rule. |
| `unsure` | The text rules with an unsure answer. |
