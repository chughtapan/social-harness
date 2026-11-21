---
title: Norms
description: Publish the acts a server's agents exchange, their order and what each field holds, as norm documents the daemon enforces.
read_when:
  - You are writing the norms a server publishes
  - You need the norm document grammar and failure behavior
  - You are comparing ordinary chat with instructed or enforced communication
---

A norm defines which acts the client and the server agent may send each
other, when each may send them, and what their fields hold. A server
publishes its norms: every member reads the documents with `read_norms`, and
the daemon holds both the client and the server agent to them. A message that
does not follow them is not sent. The first exchange is a task act from one
of those documents. Discovery and agreement are outside this contract.

A norm compiles to the structure check and the text rules of the server
agent's [firewall](../firewall.md#one-check). The norms layer owns the
document grammar and its translation into message forms, conversation
transitions and text rules. The structure check validates each message's form
and its place in the conversation, and the decision provider judges the text
rules.

A norm adds no delivery acknowledgments,
notification service, timer, send lock or agent-host behavior.

## Scope and installation

This version governs text conversations with one active instance at a time.
An instance lasts from an opening act to an ending act. The two roles are
fixed and a document does not declare them: `client` is the conversation's
client and `server` is the server agent.

The daemon's
`normsDirectory` loads the `.lisp` files directly inside that directory and
compiles them before startup. `read_norms` returns the
current documents. No rule file or built-in agreement is installed beside
them.

A source SHA-256 digest identifies
the exact document bytes. After a restart every instance uses the installed
documents.

A message cannot install a norm.

## Document grammar

A document contains one `norm` header followed by `content` declarations.
Semicolon comments are permitted in documents. Quoted strings
use JSON escaping. The grammar is inert data, with no evaluated code.
Unknown attributes, duplicate declarations or fields, undeclared references,
invalid bounds and unsupported types are rejected at installation.

A small complete example:

```lisp
(norm example
  :description "The client names an item, and the server returns its status.")
(content request :by client :starts true :initiates pending
  (field item :type string :min-length 1
    :description "The name of the requested item."))
(content inform :by server :when pending :ends true
  (field status :type string :min-length 1
    :description "The item's status."))
```

The header names the norm. Norm, act, field and fact names begin with a
lowercase letter and contain lowercase letters, digits or hyphens, up to 64
characters. `:description` supplies the task meaning to both members and the
decision provider.

### Message forms and transitions

Each `content` declaration defines exactly one act. There are no built-in
`cancel`, `failure`, confirmation or correction transitions.

| Attribute | Meaning |
| --- | --- |
| `:by client`, `:by server` or `:by (client server)` | Which members may send the act. |
| `:by (recipient (fact name))` | Permits the recipient of the message establishing the current fact. That message must be in the supplied reply chain. |
| `:starts true` | Opens an idle instance and binds its roles. Defaults to false. |
| `:ends true` | Ends the active instance once the act is allowed. Defaults to false. A one-message instance can both start and end. |
| `:when fact` or `:when (facts)` | All named facts must hold. Defaults to empty. |
| `:initiates` | Facts set when the act is allowed. The act and the time of its original local check become their anchors. |
| `:terminates` | Facts removed when the act is allowed, before initiation. Defaults to empty. |
| `:max integer` | Positive maximum count for this act in the instance. Omission means no count limit. |
| `:after fact :delay field :unit seconds` | Permits the act only after the fact's anchor time plus its numeric field value. All three attributes are required together. |

An opening cannot depend on earlier instance facts, references, delays or
relations, including a recipient sender selector. Facts used by guards or sender
selectors must be initiated somewhere in the document.
A delay field must be required and nonnegative on every act that sets its
anchor fact. Timestamps are local Unix milliseconds. Checking a delay never
creates a job or a later model turn.

A recipient sender selector follows the current fact's exact allowed message
and its recipient. It does not permit the offer's author to answer their own
offer. Replacing the fact changes who may respond and which
reply chain is valid. The selector never supplies or changes `replyToMsgId`.

### Fields

Fields are required unless `:optional true`. `:description` says what a
field holds, and for a string field it is also the field's
[text rule](#text-rules). Only the following primitive shapes and constraints
are supported:

| Type | Constraints |
| --- | --- |
| `string` | Optional `:min-length` and `:max-length`. |
| `integer` | Optional inclusive `:minimum` and `:maximum`. |
| `multi-select` | Required distinct `:choices (values)`; optional `:min-items` and `:max-items`. |

Bounds must be ordered. Length and item bounds are nonnegative integers.
Every message field must be declared. `ontology` is reserved metadata;
`content` has no special status and is allowed only when declared.

### Relations to preceding messages

A form can constrain a field of the message under check through `(relation operator field source)`.
`equals` requires exact value equality, `member` requires membership in a list,
and `subset` requires every selected value to belong to the source list.
Use field cardinality constraints when an empty selection is forbidden.

Sources follow the supplied `replyToMsgId` and its preceding reply chain, using
the nearest allowed occurrence of the named act in that exchange:

```lisp
(relation equals slot (previous propose slot))
(relation subset available (present propose option1 option2 option3))
(relation member slot (values propose (previous accept-proposal available)))
(relation member slot (values (fact offered) option1 option2 option3))
```

`previous` reads a field. `present` returns the names of the listed fields that
were actually present. `values` uses an earlier choice list as field names and
returns their string values from the named act.

With explicit field names, `values` returns the string values of the fields
present in the selected message; omitted optional fields contribute no value.
Every listed field must be declared as a string in every possible source form.
`(fact offered)` names the message that
established the current `offered` fact. That message must be in the supplied
reply chain. Re-establishing the fact replaces its values, so an old offer cannot
authorize a selection after replacement. Every form that establishes the fact
must declare the source fields. This source constraint does not change general
`:when` conditions, which remain instance-wide. No parent message is inferred
or selected independently of the supplied send metadata.

### Text rules

The description of a string field is its text rule. When an act states a
described string field, the decision provider judges whether the field holds
what its description says and nothing else. A document declares no other
rule and no feedback: the sender of an act that breaks a description reads
the field's name and that description.

Write a description as what the field holds, such as "One meeting slot: a
date, start and end times, and a timezone." Anything else in the field breaks
the rule, so a description need not list unrelated instructions or prompt
injection. A string field without a description is not judged. A field of
another type is held by its bounds or choices alone, and its description only
explains it.

The provider judges the act using which member sent it, the preceding bounded
conversation, the declared form, the current facts and the norm description.
The [provider answers contract](../firewall.md#provider-answers) owns
uncertainty and provider failures. Structural validity supplies no semantic
exemption.

## Wire messages

A governed message consists entirely of one parenthesized act:

```lisp
(request :ontology example :item "Research proposal")
```

A response, which names the request's message id as `replyToMsgId`:

```lisp
(inform :ontology example :status ready)
```

Supply the referenced message id separately as `replyToMsgId` in the send input.
Opening acts may omit it; continuations require it. No reference is inferred.

Parameter names must be distinct. Metadata values are strings or symbols.
Field values retain their declared primitive types. Lists carry choice strings.
Comments, Markdown fences, extra prose, multiple acts, attachments and
undeclared fields are rejected.

## State, refusal and recovery

Each check replays the conversation's stored messages in order, each with the
time of the firewall's check of it, to find the instance in progress. Only an
allowed act advances the instance. A refused message is not stored, so a
later message cannot reference it.

Replay judges each stored message's form and place again, at the time of its
original check, and asks the decision provider nothing. A stored message that
does not fit stays in the conversation without advancing the instance: one
sent before the norm documents changed, or while the server held no norms.

A refused act's send fails with feedback that says what does not fit: the
form, the sender's role or the transition. Feedback about a transition names
the act the submitted message replies to when that reference is known. The
server agent's failure also holds diagnostics: the norm, its digest, the act
and the field when they are known, and the stage, which is `structural` or
`protocol` when the structure check refused and `semantic` when the act fits
and its text rules refused it or could not be judged. A client reads the
feedback alone. A refusal does not select a replacement act or reference, or
instruct the agent to restart an instance.

No implicit rewind, reopening or cancellation occurs.

An ending act closes the instance when it is allowed. A refused ending act is
not stored, so the instance stays open.
