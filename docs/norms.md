---
title: Norm language
description: The language a server's norms are written in. Its syntax, the norm a document denotes, when a norm is well formed, and how each message is checked against it.
read_when:
  - You are writing a server's norms
  - You are writing acts, or need to know why one was refused
  - You are changing the norm compiler or the structure check
---

A norm says which acts the client and the server agent may send each other,
in what order, and what each field of an act may contain. Every member can
read a server's norms with `read_norms`, and the daemon enforces them on both
members. A message that does not follow them is not sent.

This page has four parts: how a norm document and an act are written, the
data a document is parsed into, when a norm is well formed, and how the
[firewall](./spec.md#one-check)'s structure check checks a message.

```mermaid
flowchart LR
    document[Norm document] -- compile --> norm[Norm]
    text[Message text] -- read --> act[Act]
    norm --> check[Structure check]
    act --> check
    conversation[Earlier messages] --> check
    check --> passed[Passed, with text rules]
    check --> refused[Refused, with feedback]
```

## Example

A client books a meeting with the server agent:

```lisp
; A client books a meeting with the server.
(norm booking
  :description "The client asks for a meeting, the server offers slots, and the client picks one.")

(act request :by client :starts true :sets requested
  (field topic :type string :min-length 1 :max-length 200
    :description "The subject of the meeting."))

(act offer :by server :when requested
  :clears requested :sets offered
  (field slots :type list :min-items 1 :max-items 3
    :description "One meeting slot: a date, start and end times, and a timezone."))

(act pick :by client :when offered :ends true
  (field slot :type string)
  (relation member slot (previous offer slots)))

(act decline :by (client server) :ends true)
```

A conversation under this norm might go as follows. Each act after the first
gives the id of the message it replies to, as `replyToMsgId` in the send.

| # | Sender | Message | Replies to | Result |
| --- | --- | --- | --- | --- |
| 1 | client | `Hello, can we meet?` | | Refused: the message is not one act. |
| 2 | server | `(request :norm booking :topic "Thesis outline")` | | Refused: `request` is not the server's to send. |
| 3 | client | `(request :norm booking :topic "Thesis outline")` | | Passed. It starts an instance, and `requested` is set. |
| 4 | server | `(offer :norm booking :slots ("Mon 10:00-10:30 UTC" "Tue 14:00-14:30 UTC"))` | 3 | Passed. `offered` is set in place of `requested`. |
| 5 | client | `(pick :norm booking :slot "Wed 09:00-09:30 UTC")` | 4 | Refused: the slot is not one of the offered slots. |
| 6 | client | `(pick :norm booking :slot "Tue 14:00-14:30 UTC")` | 3 | Refused: the reply chain from message 3 does not contain the offer. |
| 7 | client | `(pick :norm booking :slot "Tue 14:00-14:30 UTC")` | 4 | Passed. It ends the instance. |

Refused messages are not stored, so message 7 is the third message of the
conversation.

## Lexical structure

A norm document and a message's text are both sequences of these tokens:

| Token | Form |
| --- | --- |
| Whitespace | Any run of whitespace. It separates tokens and means nothing else. |
| Comment | `;` to the end of its line. A document may carry comments. A message that carries one is not an act. |
| `(` and `)` | Open and close a list. |
| String | A JSON string literal: text in double quotes with JSON escapes, on one line. It must decode to well-formed Unicode. |
| Symbol | Any other run of characters without whitespace, a parenthesis, `;` or `"`. |

A symbol has one of these forms, or none of them:

| Symbol | Form |
| --- | --- |
| Name | A lowercase letter followed by lowercase letters, digits or hyphens, 64 characters at most. Norms, performatives, fields and facts have names. |
| Keyword | `:` followed by a name, such as `:max-items`. |
| Number | A JSON number, such as `3`, `-2` or `1.5e3`. A number is whole when its value has no fractional part, so `10`, `1e1` and `2.0` are whole. |
| Truth value | `true` or `false`, which are also names. |

`Tue` and `0x2` are symbols with none of these forms. Two texts are equal when
they have the same code points in the same order, and two numbers when they have the same
value. Nothing in a document or a message is evaluated.

## Norm documents

A document is one `norm` declaration followed by one `act` declaration per
form. In the grammar below, quoted words are symbols; `name`, `string` and
`number` are the tokens above; `[ x ]` is optional; and `{ x }` repeats zero
or more times.

```ebnf
document   = norm , { form } ;

norm       = "(" , "norm" , name , [ ":description" , string ] , ")" ;

form       = "(" , "act" , name , { turn | field | relation } , ")" ;

turn       = ":by" , senders
           | ":starts" , truth
           | ":ends" , truth
           | ":when" , facts
           | ":clears" , facts
           | ":sets" , facts
           | ":max" , number
           | ":after" , name
           | ":delay" , name
           | ":unit" , "seconds" ;

senders    = role
           | "(" , role , { role } , ")"
           | "(" , "recipient" , "(" , "fact" , name , ")" , ")" ;
role       = "client" | "server" ;
facts      = name | "(" , { name } , ")" ;
truth      = "true" | "false" ;

field      = "(" , "field" , name , { field-attr } , ")" ;
field-attr = ":type" , type
           | ":optional" , truth
           | ":description" , string
           | bound , number ;
type       = "string" | "integer" | "list" ;
bound      = ":min-length" | ":max-length"
           | ":minimum" | ":maximum"
           | ":min-items" | ":max-items" ;

relation   = "(" , "relation" , operator , name , source , ")" ;
operator   = "equals" | "member" | "subset" ;
source     = "(" , "previous" , ( name | "(" , "fact" , name , ")" ) , name , ")" ;
```

These rules add to the grammar:

1. A declaration's name comes right after its first word. Attributes follow
   in any order. In an `act` declaration they may appear between fields and
   relations.
2. A declaration may use each attribute once, and only the attributes the
   grammar gives it. A misspelled attribute is an error.
3. `:by` and `:type` are required. `:after`, `:delay` and `:unit` appear
   together or not at all.
4. A field accepts only the bounds of its type: `:min-length` and
   `:max-length` for a string, `:minimum` and `:maximum` for an integer,
   `:min-items` and `:max-items` for a list.
5. No field is named `norm`, because an act names its norm with `:norm`.

Repeating a role in a sender list has no effect. An empty list of facts is the
same as leaving the attribute out. A text that does not match the grammar and
these rules is not a norm document and does not compile.

## Acts

A message's text is an act when the whole text is one list: a performative
followed by keyword and value pairs.

```ebnf
act       = "(" , name , { keyword , value } , ")" ;
value     = string | symbol | "(" , { string | symbol } , ")" ;
```

```lisp
(offer :norm booking :slots ("Mon 10:00-10:30 UTC" "Tue 14:00-14:30 UTC"))
```

1. The performative is a name, and each keyword is `:` followed by a name.
2. No keyword appears twice.
3. `:norm` is required. Its value is text that names the act's norm. Every
   other pair is a field of the act.
4. A string is text. A symbol that has the form of a number is that number, which must be finite.
   Any other symbol is text, whatever its form, so `Tue` and `"Tue"` are the
   same value. Every
   item of a list is text, including one that looks like a number.

A message whose text does not match the grammar and these rules is not an
act. That includes a text with anything outside the one list, such as prose,
a second list, a comment or a Markdown fence.

The message an act replies to is not part of the act. The sender gives it as
`replyToMsgId` in the [send](./spec.md#sending-a-message). It is never
inferred.

## The norm a document denotes

Parsing a document produces a norm, which is plain data. The well-formedness
rules and the structure check are defined on this data, not on the
document's text.

```text
Norm     = { name, description, forms: Form* }

Form     = { performative,
             by: Senders,
             fields: Field*,
             starts, ends: Boolean,
             when, clears, sets: Fact*,
             max?: Number,
             delay?: { fact, secondsField },
             relations: Relation* }

Senders  = roles(Role+)            ; a member that has one of these roles
         | recipient(Fact)         ; the recipient of the message that set the fact

Field    = { name, optional: Boolean, description?: String }
           and one of
             string  { minLength?, maxLength? }
             integer { minimum?, maximum? }
             list    { minItems?, maxItems? }

Relation = { operator: equals | member | subset,
             field,
             source: { act: EarlierAct, field } }

EarlierAct = performative(name)    ; the latest act of this performative
           | fact(Fact)            ; the act that set this fact

Act        = { performative, norm, fields: name -> FieldValue }
FieldValue = String | Number | String*
```

Each part of a document becomes one part of the norm:

| Document | Norm | When absent |
| --- | --- | --- |
| `(norm name …)` | `name` | Required. |
| `:description` of the norm | `description` | Empty. |
| `(act name …)` | A form whose `performative` is the name | |
| `:by` | `by` | Required. |
| `:starts`, `:ends` | `starts`, `ends` | False. |
| `:when`, `:clears`, `:sets` | `when`, `clears`, `sets` | No facts, as for an empty list. |
| `:max` | `max` | No limit. |
| `:after f :delay d :unit seconds` | `delay` with `fact` f and `secondsField` d | No delay. |
| `(field name …)` | A field | |
| `:optional` | `optional` | False: the field is required. |
| `:description` of a field | `description` | None. |
| `(relation op field (previous a f))` | A relation | |

## Well-formed norms

A document compiles when it parses and the resulting norm is well formed.
The daemon refuses to start with a document that does not compile. A norm is
well formed when it follows these rules:

1. The norm, every performative, every field and every fact has a valid
   name.
2. No two forms declare the same performative, and no two fields of a form
   have the same name.
3. At least one form starts an instance.
4. A field's lower bound is not above its upper bound. The bounds of a string
   and of a list are whole numbers of zero or more. The bounds of an integer
   are any numbers.
5. `max` is a whole number of one or more.
6. Every fact in a `when`, a `clears`, a `recipient`, a delay or a
   relation's source is in the `sets` of some form.
7. A form that starts an instance names its senders by role, and has no fact
   in `when`, no delay and no relation.
8. A form with a delay lists the delay's fact in `when`. Every form that
   sets that fact declares the delay's `secondsField` as a required integer
   with a `minimum` of zero or more. A check that reaches the delay therefore
   always finds the act that set the fact and its number of seconds.
9. A form with a relation declares the relation's field. Every form the
   source can refer to declares the source's field as required, so the
   earlier act always has it. A source that names a performative refers to
   one form. A source that names a fact refers to every form that sets the
   fact. The field types must suit the operator:

   | Operator | The form's field | The source's field |
   | --- | --- | --- |
   | `equals` | Any type | The same type |
   | `member` | String | List |
   | `subset` | List | List |

A norms directory must have at least one document, and no two documents may
name the same norm.

## Checking a message

The structure check checks one message at a time. It is given the server's
norms, the message with its sender's role and optional `replyToMsgId`, the
time of the check, and the conversation's stored messages, each with the
time of its own check. Times are in Unix milliseconds.

It either passes the message and returns its [text rules](#text-rules), or
refuses it with [feedback](#refusals). A server without norms runs no
structure check.

### State of a conversation

A check uses the state below. The state is never saved: each check rebuilds
it from the stored messages.

| Part | Meaning |
| --- | --- |
| Stored messages | The id of every stored message. |
| Instance | The instance in progress, if any: its norm and the parts below. |
| Facts | The facts that are set, each with the act that set it. |
| Times sent | How many acts of each performative passed in the instance. |
| Acts | The acts that passed in the instance, in order. |
| Thread | The messages that belong to the instance, each with the message it replies to. |

The reply chain of a message is that message, the message it replies to, and
so on, for as long as each one is in the thread.

### Steps

A message goes through these steps in order. The first step that fails
refuses the message, at the stage shown. The `form` stage checks the message
itself, and the `protocol` stage checks it against the conversation.

| Step | The message is refused when | Stage |
| --- | --- | --- |
| 1 | Its text is not an [act](#acts). | Form |
| 2 | No instance is in progress and `:norm` is not the name of one of the server's norms. | Form |
| 3 | An instance is in progress and `:norm` is not the name of the instance's norm. | Protocol |
| 4 | The norm declares no form for the performative. | Form |
| 5 | A required field is missing, a field the act includes is not declared, or a value is not of its field's type or within its bounds. The feedback names every such field. | Form |
| 6 | The form does not start an instance and the message has no `replyToMsgId`. | Protocol |
| 7 | The message has a `replyToMsgId` that is not a stored message. | Protocol |
| 8 | No instance is in progress and the form does not start one, or an instance is in progress and the form starts one. | Protocol |
| 9 | An instance is in progress and the reply chain of `replyToMsgId` is empty: the act replies outside the instance. | Protocol |
| 10 | The senders are a `recipient` and its fact is not set, or the act that set it is not in the reply chain. | Protocol |
| 11 | The sender is not one `by` permits: it has none of the listed roles, or it is not the recipient of the message that set the fact. | Protocol |
| 12 | A fact of `when` is not set, or `max` acts of this performative already passed in the instance. | Protocol |
| 13 | The form has a delay that has not passed. The delay runs from the check time of the act that set its fact, for the seconds in that act's `secondsField`, whether or not that act is in the reply chain. | Protocol |
| 14 | A relation is not satisfied. Relations are tried in the order the form declares them. | Protocol |

From step 2 on, the message is checked under one norm: the norm of the
instance in progress, or the norm that `:norm` names when there is no
instance. An act that starts an instance goes through steps 1 to 8 and then
step 11. It may carry a `replyToMsgId` that names a stored message, but that
has no effect: the new instance begins with the act itself.

A field's value fits its type as follows:

| Type | Value | Bounds |
| --- | --- | --- |
| `string` | Text. | `minLength` and `maxLength` count code points. |
| `integer` | A whole number. | `minimum` and `maximum` are inclusive. |
| `list` | A list of texts, none empty. | `minItems` and `maxItems` count items. |

A relation compares a field of the act with a field of an earlier act. The
earlier act must be in the reply chain. For a source that names a
performative, it is the latest act of that performative that passed in the chain. For a
source that names a fact, it is the act that set the fact.

| Operator | Satisfied when |
| --- | --- |
| `equals` | The field has exactly the earlier value: the same text, the same number, or the same items in the same order. |
| `member` | The field is equal to one of the earlier list's items. |
| `subset` | Every item of the field is equal to one of the earlier list's items. |

A relation fails when the earlier act is not in the chain, when the act does
not include the relation's field, or when the operator is not satisfied.
When a fact is set again, a source that names the fact refers to the newer
act, so an old offer cannot authorize a selection after a new one.

Every refusal by the structure check has the reason `violation`.

### Effects of an act that passed

A stored act that passed changes the state as follows:

1. If its form ends an instance, the instance is over and all of its state
   is discarded.
2. Otherwise, if no instance is in progress, one starts under the act's norm.
3. The facts in `clears` are cleared. Then the facts in `sets` are set, each
   by this act.
4. The count for the act's performative goes up by one, and the act is added
   to the instance's acts.

A stored message joins the thread of the instance in progress when it is the
act that started the instance, or when it replies to a message in the
thread.

### Replay

The state before a message comes from replaying the conversation's stored
messages in order. Each stored message goes through the steps above again,
as its original sender and at the time of its original check. A message that
passes has its effects.

A stored message can fail on replay in two cases: it was stored before the
norm documents changed, or it was stored while the server had no norms and
so has no check time. Such a message has no effects, but it may still join
the thread.

A refused message is never stored, so it leaves nothing in the state and a
later message cannot reply to it. Only an act of the norm can end or restart
an instance.

## Text rules

A string or list field with a description has a text rule. When an act that
passed the structure check includes such a field, the decision provider
judges whether the field contains only what its description says. A list's
description applies to each of its items.

| Field | Rule text |
| --- | --- |
| String | `<field> must contain only what its description says: <description>` |
| List | `each item of <field> must contain only what its description says: <description>` |

A rule's id is `<norm>.<performative>.<field>`, such as
`booking.request.topic`. A document declares no other kind of rule and no
feedback text: the sender of an act that breaks a description is given the
rule's text.

Write a description as what the field contains, such as "One meeting slot: a
date, start and end times, and a timezone." Anything else in the field breaks
the rule, so a description does not need to forbid unrelated instructions or
prompt injection. A field without a description is not judged. An integer
field is limited only by its bounds; its description is not judged.

The provider is told which member sent the act and is shown the
[history window](./spec.md#history-window), the form's fields, the facts that
are set and the norm's description.
[Provider answers](./spec.md#provider-answers) covers unsure answers and
provider failures.

## Refusals

The send of a refused message fails with feedback that says what does not
fit: the form, the sender or the turn. When an act is out of turn, the feedback names the performative of the act
it replies to, if that act passed.

| Refused at | Rule id | Feedback, for example |
| --- | --- | --- |
| Form stage | `<norm>-form` | `note is not a valid field of pick in booking.` |
| Protocol stage | `<norm>-protocol` | `pick is not valid after offer for booking.` |
| A text rule | `<norm>.<performative>.<field>` | The rule's text. |

The norm in a structure check's rule id is the norm the message was checked
under. For a message refused at step 1, that is the norm of the instance in
progress. A message refused at step 1 or 2 while no instance is in progress
was checked under no norm, and its rule id is `norm-form`.

[Refused messages](./spec.md#refused-messages) says what each sender is given
besides the feedback. A refusal never suggests a replacement act or reply
reference, and never tells the agent to restart an instance.

## Publishing norms

The daemon's `normsDirectory` setting names a directory. Before it serves,
the daemon compiles every `.lisp` file directly inside that directory. It refuses to start when the directory cannot be read, when it has no such
file, when one does not compile, or when two name the same norm.

The compiled norms are the server's norms until the daemon stops.
`read_norms` returns each norm's name, description and document, and the
firewall enforces all of them. There are no other rules, and a message cannot
install a norm.

After a restart, every conversation is checked under the documents that are
in the directory at that time, as [replay](#replay) describes.

A norm adds no acknowledgment, notification, timer or host behavior. A delay
only refuses an act that is sent too early. It schedules nothing; the host
waits.
