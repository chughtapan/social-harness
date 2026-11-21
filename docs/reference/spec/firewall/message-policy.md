---
title: Message firewall
description: How the server agent's message policy governs what it sends and receives.
read_when:
  - You need to know what a firewall decision permits or refuses
  - You are configuring rules
---

The message firewall checks every message of the server agent's conversations
against its owner's rules and the norms it holds: what a client sends the
server agent, and what the server agent sends a client. It receives a message
and the earlier messages of its conversation. It returns a decision, the rules
that determined it, and the feedback the sender of a refused message reads.

The firewall owns the message policy in force and its checks. The daemon
supplies the message and its conversation, applies the decision to the send,
and saves a record of the check, which survives a restart.

The firewall is optional and experimental. Without a message-policy file,
`sharnessd` checks no message.
[Only the server agent](../modes.md#firewall-and-norms) has a firewall. The
host owns models, tools and the agent's private context.

## Norms

The [norms](../norms/norms.md) the server agent holds give each message a
form, a place in its conversation's protocol and text rules of their own. The
structure check judges the form and the protocol first and refuses a message
that fails either. A message that passes continues to the text rules that
apply to it.

A continuation's reply reference must belong to the active instance. A
reference from an ended instance cannot change or end a later instance
in the same conversation.

## Decisions

A check allows its message or refuses it, whichever agent sent it, and a
refused message's send fails. The text rules that apply to a message judge it
once the structure check has passed it. Their answers combine in priority
order:

1. A settled rule violation refuses.
2. An unsure answer refuses as unresolved evidence.
3. Otherwise, allow.

Every rule the check judges needs an answer, and a pass cannot erase another
rule's violation. A check without a valid answer for every rule is
unavailable: it decides nothing, its message's send fails, and it leaves no
record. A cancelled check produces no decision. A check cannot alter its
message.

### Provider answers

Text rules describe when they apply and the conduct they require. A
[norm rule](../norms/norms.md#text-rules)'s `:act` and a policy rule's
`applies` only select which rules judge a message.

For each rule, the decision provider answers one question about the message:
does it break the rule? The answer is `compliant` or `violation`, with a
probability for each. A message the server agent sends is judged as its own
draft, and a message a client sends is judged as its peer's.

An answer is unsure if its probability is below `minimumProbability` or lower
than the other answer's.

| Answer | Decision |
| --- | --- |
| Settled violation | Refused, with the rule's feedback |
| Settled compliant | Allowed |
| Unsure | Refused as unresolved evidence, with the rule's feedback, so its sender can revise it |

Invalid output or provider failure makes the check unavailable. Accepting
nonempty rule text promises no accuracy of its checks in any language.

## Refused messages

A refused message is not stored, its recipient never reads it, and its send
fails. A corrected message is a new send with a new check. The daemon neither
changes a message nor sends a substitute or a later approval. An allowed
message reaches its recipient's host unchanged.

A client is not trusted with the server agent's policy, so what a failed send
says depends on who sent it:

| Sender | Reads |
| --- | --- |
| Server agent | The reason (`rule-violation`, `unresolved-evidence` or `check-unavailable`), the check id and the feedback of the deciding rules. A refusal under a norm adds the [structure check's diagnostics](../norms/norms.md#state-refusal-and-recovery). |
| Client | The feedback of the deciding rules, or that the message was not accepted when they give none. When the check was unavailable, only that the server is unavailable and to try again later. |

A client's failure names no check, rule, reason or diagnostics. Neither
failure carries private evidence, credentials or raw provider output.
[Failed sends](../host/messaging.md#failed-sends) gives the fields of each
failure.

Feedback is the only part of a rule a client reads. Write it for the sender
of a refused message, and leave out what a client should not learn.

## Evidence

A check receives its message, the rules and the earlier messages of the
conversation once. It applies to that message and those earlier messages as
captured, without a second check when later messages arrive. An allowed
message is stored with the recipient, text and message id that were checked.

### Available history

The decision provider reads the preceding messages in conversation order,
excluding the message under check. The daemon's `maximumHistoryRecords`
setting limits them to the latest 256 by default, configurable from 1 to
1024. A check uses the conversation of its message; other conversations and
host private context are excluded. The window also holds at most 2 MiB of messages, the latest that
fit. `earlierHistoryOmitted` tells the provider that earlier messages were
left out, and refuses nothing. The structure check separately receives every
preceding message with the time of the firewall's check of it, outside this
window.

A rule that needs other conversations, older messages or instructions the
owner gave elsewhere cannot be judged from this evidence.

## Message-policy file

The settings file's `messagePolicyFile` names a JSON file.

| Property | Requirement/default |
| --- | --- |
| `rules` | Optional: a `TextRule` array, default `[]`. |
| `decisionProvider` | Required with `rules` and for held norms with text rules: `{model}`. |
| `settings` | Defaults: `minimumProbability` 0.8, below which an answer is unsure; 15 s per request. |
| `maximumConcurrentChecks` | Optional: how many requests to the provider run at once, from 1 to 32, default 4. |

| Rule field | Requirement |
| --- | --- |
| `id` | Required. |
| `text` | Required. |
| `applies` | Required: `incoming` for messages clients send, `outgoing` for messages the server agent sends, or `both`. |
| `feedback` | Optional: what the sender of a message that breaks the rule reads. |

Duplicate ids prevent startup.

Unknown properties and unsupported values fail. The norms the server agent
holds add their [text rules](../norms/norms.md#text-rules) after the file's
rules, so a daemon whose norms have rules needs `decisionProvider` even when
the file has no `rules`.

Without `decisionProvider`, no provider or key is used. A provider's rate
limit makes a check unavailable.

## Decision records

Each completed check leaves one record. An unavailable or cancelled check
leaves none, and neither does a send that fails before its check, such as one
to an unknown client. `read_firewall_decisions` returns the server agent's
records as saved, newest first, without message content, message ids or
private evidence.

| Field | Meaning |
| --- | --- |
| `checkId` | Identifies the check. |
| `direction` | `incoming` for a message a client sent, `outgoing` for one the server agent sent. |
| `decision` | `allowed` or `refused`. |
| `reason` | `eligible`, `rule-violation` or `unresolved-evidence`. |
| `time` | When the check ran, in Unix milliseconds. |
| `peer` | The client of the message: the recipient of an outgoing message and the author of an incoming one. A refused first message leaves a record that names its author and no conversation. |
| `checkedRuleIds` | The rules the check judged. A rule that does not apply to the message's direction is not listed. |
| `decidedBy` | The deciding rules in policy order, each with the `feedback` its rule declares. A structure check's rule is named for its norm and the stage that refused, `structural` or `protocol`, and its explanation is not saved. |

| Reason | Deciding rules |
| --- | --- |
| Rule violation | Violated rules. |
| Unresolved evidence | Rules with an unsure answer, or the rule of a structure check that could not settle the message. |
| Eligible | None. |
