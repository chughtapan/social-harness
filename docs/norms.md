---
title: Norm language
description: The language a server's norms are written in, and how each message is checked against them.
read_when:
  - You are writing a server's norms
  - You are writing acts, or need to know why one was refused
---

A norm is a published rule for one kind of exchange between a client and the
server agent, such as booking a meeting. It says which messages each side may
send, in what order, and what each part of a message may contain. Every
member can read a server's norms with `read_norms`. The daemon checks every
message against them, and a message that does not follow them is not sent.

The first two sections explain how norms work. The rest is reference.

## Example

This norm lets a client book a meeting with the server agent:

```lisp
; A client books a meeting with the server.
(norm booking
  :description "The client asks for a meeting, the server offers slots, and the client picks one.")

(act request :by client :starts true :sets requested
  (field topic :type string :min-length 1 :max-length 200
    :description "The subject of the meeting."))

(act offer :by server :when requested
  :clears requested :sets offered
  (field slots :type list :min-items 1 :max-items 3 :format date-time)
  (field length :type string :format duration))

(act pick :by client :when offered :ends true
  (field slot :type string :format date-time)
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
| 4 | server | `(offer :norm booking :slots ("2026-11-23T10:00:00Z" "2026-11-24T14:00:00Z") :length "PT30M")` | 3 | Passed. `offered` is set in place of `requested`. |
| 5 | client | `(pick :norm booking :slot "2026-11-25T09:00:00Z")` | 4 | Refused: the slot is not one of the offered slots. |
| 6 | client | `(pick :norm booking :slot "2026-11-24T14:00:00Z")` | 3 | Refused: the reply chain from message 3 does not contain the offer. |
| 7 | client | `(pick :norm booking :slot "2026-11-24T14:00:00Z")` | 4 | Passed. It ends the instance. |

Refused messages are not stored, so message 7 is the third message of the
conversation.

## How a norm works

This section describes what a norm means. It does not depend on how a norm is
written; [Syntax](#syntax) covers that.

**Acts.** A message under a norm is an *act*. An act has a *performative*,
which is the kind of act it is, the name of its norm, and named *fields*. In
the example, the first accepted message is an act with the performative
`request`, the norm `booking`, and one field, `topic`.

**Forms.** A norm declares one *form* for each performative. A form lists the
fields an act of that kind carries, and gives its *turn rule*: the conditions
under which the act may be sent.

**Instances.** One run of a norm in a conversation is an *instance*. A form
says whether its act starts an instance or ends one. In the example,
`request` starts a booking, and `pick` or `decline` ends it. A conversation
has at most one instance in progress.

**Facts order the acts.** A *fact* is a named flag of an instance. A form
says which facts its act sets, which it clears, and which must already be set
before the act may be sent. In the example, `request` sets `requested`.
`offer` requires `requested`, clears it and sets `offered`. `pick` requires
`offered`. The order request, offer, pick is therefore not a separate state
machine. It follows from the facts each act requires and changes.

**Who may send.** A form names the member that may send its act: the client,
the server agent, or either. It can instead name the recipient of an earlier
act.

**Other conditions.** A turn rule can also limit how many times an act is
sent in an instance, require a wait after an earlier act, and constrain a
field by a field of an earlier act with a *relation*. In the example, the
slot a client picks must be one of the slots the server offered.

**Replies link the acts.** Every act after the first replies to an earlier
message, and those replies form the instance's *thread*. A relation finds the
earlier act by following the replies back. That is why message 6 in the
example is refused: it replies to the request, not to the offer.

**What a field may contain.** A field has a type and optional limits, such as
a length or a date format, which are checked exactly. The types are JSON's:
text, numbers, booleans, lists and records. A text, list or record field can
also have a description in plain language. A decision provider judges whether the field's text is what
the description says. That requirement is the field's *text rule*.

**Checking.** When a message is sent, the structure check decides whether it
is an act that fits its form and that its sender may send now. It works out
the instance's facts by replaying the conversation's stored messages. If the
act passes, its text rules go to the decision provider.

## Syntax

A norm document and an act are parenthesized text. Nothing in them is
evaluated.

- A **string** is a JSON string literal on one line.
- A **name** is a lowercase letter followed by lowercase letters, digits or
  hyphens, at most 64 characters. A **keyword** is `:` and a name.
- A **number** is written as in JSON. `true` and `false` are booleans.
- A **symbol** is any other run of characters without spaces, parentheses,
  `;` or `"`.
- `;` starts a comment that runs to the end of the line. A document may have
  comments. A message may not.

### Norm documents

A document is one `norm` declaration followed by one `act` declaration per
form. Quoted words are literal, `[ x ]` is optional and `{ x }` repeats.

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
           | ":after" , "(" , name , name , ")" ;

senders    = role
           | "(" , role , { role } , ")"
           | "(" , "recipient" , "(" , "fact" , name , ")" , ")" ;
role       = "client" | "server" ;
facts      = name | "(" , { name } , ")" ;
truth      = "true" | "false" ;

field      = "(" , "field" , name , { field-attr | shape } , ")" ;
field-attr = ":optional" , truth
           | ":description" , string ;
item       = "(" , "item" , { shape } , ")" ;
shape      = ":type" , type
           | ":format" , format
           | bound , number
           | field
           | item ;
type       = "string" | "integer" | "number" | "boolean" | "list" | "record" ;
format     = "date" | "time" | "date-time" | "duration" ;
bound      = ":min-length" | ":max-length"
           | ":minimum" | ":maximum"
           | ":min-items" | ":max-items" ;

relation   = "(" , "relation" , operator , name , source , ")" ;
operator   = "equals" | "member" | "subset" ;
source     = "(" , "previous" , ( name | "(" , "fact" , name , ")" ) , name , ")" ;
```

- Attributes come in any order, each at most once. An unknown attribute is
  an error.
- `:by` and `:type` are required.
- `:after (fact field)` requires a wait: the act that set `fact` gives the
  number of seconds in its `field`.
- A record contains fields. A list contains at most one `item`, the shape of
  its items; without one its items are nonempty strings.
- A bound must suit the type: `:min-length` and `:max-length` for a string,
  `:minimum` and `:maximum` for an integer or number, `:min-items` and
  `:max-items` for a list.
- `:format` goes on a string, or on a list that declares no `item`.
- A field inside a record takes no `:description`.
- No field is named `norm`.

### Acts

A message is an act when its whole text is one list: a performative followed
by keyword and value pairs.

```ebnf
act       = "(" , name , { keyword , value } , ")" ;
value     = string | symbol | list | record ;
list      = "(" , { value } , ")" ;
record    = "(" , keyword , value , { keyword , value } , ")" ;
```

```lisp
(offer :norm booking :slots ("2026-11-23T10:00:00Z" "2026-11-24T14:00:00Z") :length "PT30M")
```

- `:norm` is required and names the act's norm. Every other pair is a field.
- No keyword appears twice.
- A bare word is a number if it looks like one, a boolean if it is `true` or
  `false`, and text otherwise, so `Tue` and `"Tue"` are the same. Quote text
  that looks like a number or a boolean.
- `(:name value ...)` is a record. Any other parenthesized value is a list.
- Anything outside the one list, such as prose, a comment or a Markdown
  fence, makes the message not an act.

The message an act replies to is not part of the act. The sender gives it as
`replyToMsgId` in the [send](./spec.md#sending-a-message).

## Field types

| Type | Value | Bounds |
| --- | --- | --- |
| `string` | Text, in its `format` if it has one. | Length in code points. |
| `integer` | A whole number. | Inclusive. |
| `number` | Any number. | Inclusive. |
| `boolean` | `true` or `false`. | None. |
| `list` | Items that each fit its `item`. | Number of items. |
| `record` | Every required field, and no undeclared field. | None. |

The formats are those of JSON Schema:

| Format | Text | Example |
| --- | --- | --- |
| `date` | An RFC 3339 date that exists in the calendar. | `2026-11-23` |
| `time` | An RFC 3339 time, with seconds and an offset. | `10:00:00Z` |
| `date-time` | A date, `T`, then a time. | `2026-11-23T10:00:00+01:00` |
| `duration` | An ISO 8601 duration. | `PT30M` |

## Well-formed norms

The daemon refuses to start with a norm that breaks one of these rules:

1. Names are valid, each performative has one form, and field names are
   unique within a form or a record.
2. At least one form starts an instance. A form that starts one names its
   senders by role and has no required fact, delay or relation.
3. A lower bound is not above its upper bound. Length and item bounds are
   whole numbers of zero or more. `:max` is a whole number of one or more.
4. Every fact a form requires, clears or refers to is set by some form.
5. A form with a delay requires the delay's fact. Every form that sets that
   fact has the seconds field as a required integer with a `:minimum` of 0 or
   more.
6. A relation's field is declared, and its source field is required on every
   act the source can refer to. The types must suit the operator:

   | Operator | The field | The source field |
   | --- | --- | --- |
   | `equals` | Any type | The same type |
   | `member` | The type of the list's items | List |
   | `subset` | List | List with items of the same type |

A server needs at least one norm, and no two may have the same name.

## Checking a message

The structure check refuses a message at the first of these that applies.
The form stage checks the message itself, and the protocol stage checks it
against the conversation. The stage goes into the refusal's rule id.

| The message is refused when | Stage |
| --- | --- |
| Its text is not an act. | Form |
| No instance is in progress and `:norm` names none of the server's norms. | Form |
| An instance is in progress and `:norm` names a different norm. | Protocol |
| The norm has no form for the performative. | Form |
| A required field is missing, a field is not declared, or a value does not fit its type. The feedback names every such field. | Form |
| It does not start an instance and has no `replyToMsgId`, or its `replyToMsgId` is not a stored message. | Protocol |
| It starts an instance while one is in progress, or does not start one while none is. | Protocol |
| It replies to a message outside the instance. | Protocol |
| Its sender is not the member the form allows. | Protocol |
| A fact it requires is not set, or it was already sent `:max` times. | Protocol |
| Its delay has not passed, counted from the check of the act that set the delay's fact. | Protocol |
| A relation is not satisfied, or the act omits the relation's field. | Protocol |

A relation compares a field with a field of an earlier act that the message
replies to, directly or through earlier replies. `equals` requires the same
value; lists are equal with equal items in order, and records with the same
fields in any order. `member` requires the value to be one of the earlier
list's items, and `subset` every item to be. When a fact is set again, a
relation that names the fact refers to the newer act.

An act that passes and is stored takes effect: it starts or ends the
instance, clears and sets its facts, and counts toward `:max`. A refused
message is not stored and has no effect.

After a restart, every conversation is checked under the documents then in
the norms directory.

## Text rules

A string, list or record field with a description has a text rule: the
decision provider judges whether the field contains only what its
description says. A list's description applies to each item. A description on a number or a
boolean is not judged. A rule's id is
`<norm>.<performative>.<field>`, and its text is what the sender is given
when the rule refuses the act.

Write a description as what the field contains, such as "The subject of the
meeting." Where a field has a fixed shape, such as a date, give it a
`:format` instead: a format is checked exactly and needs no provider.

[Provider answers](./spec.md#provider-answers) covers unsure answers and
provider failures.

## Refusals

A refused message's send fails with feedback that says what does not fit.

| Refused by | Rule id | Feedback, for example |
| --- | --- | --- |
| Form stage | `<norm>-form` | `note is not a valid field of pick in booking.` |
| Protocol stage | `<norm>-protocol` | `pick is not valid after offer for booking.` |
| A text rule | `<norm>.<performative>.<field>` | The rule's text. |

Every structure check refusal has the reason `violation`. A message sent while no instance is in progress that is not an act, or names
no norm of the server, has the rule id `norm-form`. [Refused messages](./spec.md#refused-messages) says what else
each sender is given.

## Publishing norms

The `normsDirectory` setting names a directory. At startup the daemon
compiles every `.lisp` file directly inside it, and refuses to start if
there is none, one does not compile, or two name the same norm. Those are
the server's norms until the daemon stops. A message cannot install a norm.

A norm adds no notification, timer or host behavior. A delay only refuses an
act sent too early; the host waits.

## Prior work

- **Speech-act theory.** A message is an action.
- **[FIPA-ACL](http://www.fipa.org/specs/fipa00037/).** Performatives and
  protocols. Unlike FIPA, an act's meaning here is its effect on observable
  facts, not the sender's beliefs
  ([Singh, 1998](https://www.csc2.ncsu.edu/faculty/mpsingh/papers/mas/computer-acl-98.pdf)).
- **Event calculus** (Kowalski and Sergot, 1986). Acts set and clear facts,
  and state is computed by replaying them.
