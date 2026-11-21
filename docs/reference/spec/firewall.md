---
title: Message firewall
description: How the server agent's firewall holds every message to the norms the server publishes.
read_when:
  - You need to know what a firewall decision permits or refuses
  - You need to know what the sender of a refused message reads
---

The message firewall checks every message of the server agent's conversations
when it is sent: what a client sends the server agent, and what the server
agent sends a client. It holds each message to the
[norms](./norms/norms.md) the server publishes. It receives a message, which
member sent it and the earlier messages of its conversation. It returns a
decision, the rules that determined it, and the feedback the sender of a
refused message reads.

The firewall owns its checks. The daemon supplies the message and its
conversation, applies the decision to the send, and saves a record of the
check, which survives a restart.

A server without norms has no firewall, and `sharnessd` checks no message.
[Only the server agent](./modes.md#firewall-and-norms) has a firewall. The
host owns models, tools and the agent's private context.

## One check

A check has two parts, in order:

1. The structure check reads the message as an act of a held norm and judges
   its form and its place in the conversation's protocol. It refuses a
   message that fails either.
2. The decision provider judges the text rules of an act that passed: one
   rule for each [described string or list field](./norms/norms.md#text-rules)
   the act states.

A continuation's reply reference must belong to the active instance. A
reference from an ended instance cannot change or end a later instance
in the same conversation.

## Decisions

A check allows its message or refuses it, whichever member sent it, and a
refused message's send fails. The answers to an act's text rules combine in
priority order:

1. A settled rule violation refuses.
2. An unsure answer refuses as unresolved evidence.
3. Otherwise, allow.

Every rule the check judges needs an answer, and a pass cannot erase another
rule's violation. A check without a valid answer for every rule is
unavailable: it decides nothing, its message's send fails, and it leaves no
record. A cancelled check produces no decision. A check cannot alter its
message.

### Provider answers

A text rule holds one field to its description: the field must hold what the
description says and nothing else. The norm's author writes the description,
and the firewall derives the rule from it.

For each rule, the decision provider answers one question about the message:
does it break the rule? The answer is `compliant` or `violation`, with a
probability for each. The provider is told which member sent the message and
judges it as that member's.

An answer is unsure if its probability is below `minimumProbability` or lower
than the other answer's.

| Answer | Decision |
| --- | --- |
| Settled violation | Refused, with the rule as feedback |
| Settled compliant | Allowed |
| Unsure | Refused as unresolved evidence, with the rule as feedback, so its sender can revise it |

Invalid output or provider failure makes the check unavailable. Accepting a
description promises no accuracy of its checks in any language.

## Refused messages

A refused message is not stored, its recipient never reads it, and its send
fails. A corrected message is a new send with a new check. The daemon neither
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
| Server agent | The reason (`rule-violation`, `unresolved-evidence` or `check-unavailable`), the check id and the feedback. A message read as an act of a norm adds the [structure check's diagnostics](./norms/norms.md#state-refusal-and-recovery). |
| Client | The feedback. When the check was unavailable, only that the server is unavailable and to try again later. |

A client's failure holds nothing else: no check id, no rule id, no word of
which kind of refusal it was and no diagnostics. Neither failure carries
private evidence, credentials or raw provider output.
[Failed sends](./host/messaging.md#failed-sends) gives the fields of each
failure. Every member reads the norm documents whole with `read_norms`, so
feedback tells a client nothing it could not read there.

## Evidence

A check receives its message and the earlier messages of the conversation
once. It applies to that message and those earlier messages as captured,
without a second check when later messages arrive. An allowed message is
stored with the recipient, text and message id that were checked.

The decision provider is a service outside the daemon. Each check that has a
text rule to judge sends it the message, the names of both agents, the rules,
the norm's description with the act's form and current facts, and the history
window below.

### Available history

The decision provider reads the preceding messages in conversation order,
excluding the message under check. The daemon's `maximumHistoryRecords`
setting limits them to the latest 256 by default, configurable from 1 to
1024. A check uses the conversation of its message; other conversations and
host private context are excluded. The window also holds at most 2 MiB of
messages, the latest that fit. `earlierHistoryOmitted` tells the provider that
earlier messages were left out, and refuses nothing. The structure check
separately receives every preceding message with the time of the firewall's
check of it, outside this window.

A description that needs other conversations, older messages or instructions
the owner gave elsewhere cannot be judged from this evidence.

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
holds no message content, message id or private evidence.

| Field | Meaning |
| --- | --- |
| `checkId` | Identifies the check. |
| `sender` | Which member sent the message: `client` or `server`. |
| `client` | The client of the message's conversation. A client's refused first message leaves a record and no conversation. |
| `decision` | `allowed` or `refused`. |
| `reason` | `eligible` for an allowed message, `rule-violation` or `unresolved-evidence` for a refused one. |
| `time` | When the check ran, in Unix milliseconds. |
| `checkedRuleIds` | The rules the check judged. |
| `decidedBy` | The deciding rules, each with its `feedback`. A text rule is its norm, act and field: `office-hours.request.topic`. A structure check's rule is the stage that refused, `structural` or `protocol`, after the name of the norm of the instance in progress, or after `norm` when there is none: `office-hours-protocol`. Its feedback is not saved. |

| Reason | Deciding rules |
| --- | --- |
| Rule violation | Violated rules. |
| Unresolved evidence | Rules with an unsure answer, or the rule of a structure check that could not settle the message. |
| Eligible | None. |
