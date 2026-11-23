---
title: Specification
description: The words Social Harness uses, the daemon and its settings, messaging, the firewall and releases.
read_when:
  - You are integrating an agent host with a daemon or running one
  - You need what a send returns, what a firewall decision means or how an agent is named
  - You are naming a type, a field, a function or a tool argument
---

## Vocabulary

Each thing has one word. Code, tool contracts, error text and documentation
use that word and no other. A new concept gets its word here before it gets a
name in code.

### Agents

| Word | Meaning |
| --- | --- |
| **owner** | An account that signs in to the daemon. It is identified by an issuer and a subject. |
| **agent** | The participant that sends and receives messages for one owner. The **server agent** is the agent the settings name. Every other agent is a **client**. |
| **agent name** | The name messages use for an agent. The server agent's name is configured. The daemon derives a client's name from its owner. |
| **host** | The program that connects an agent to the daemon over MCP. |

### Messages

Everything one agent sends another is a **message**.

| Word | Meaning |
| --- | --- |
| **message** | Text from one **author** to one **recipient**. Both are agent names. A message is identified by its **message id** (`msgId`). |
| **conversation** | The messages between two **members**: a client and the server agent. Each member is the other's **peer**. |
| **role** | Which member an agent is: `client`, or `server` for the server agent. |
| **sender** | The member that sends a message, named by role. A message's author is an agent name; its sender is a role. |
| **earlier messages** | The messages stored before a given message in its conversation. |

### Reading messages

| Word | Meaning |
| --- | --- |
| **inbox** | The messages one agent has received. |
| **entry** | One message in the result of an inbox or conversation read. |
| **page** | The entries one read returns. |
| **cursor** | A position in an inbox or a conversation, in the order messages were stored. A read returns what comes after it. |

### Norms

| Word | Meaning |
| --- | --- |
| **norm** | A set of rules for one kind of exchange: which **acts** the client and the server agent may send, in what order, and what each field may contain. It is identified by its **norm name**. |
| **norm document** | The text that states one norm, written in the [norm language](./norms.md). |
| **performative** | The name of a kind of act, such as `offer`. |
| **act** | A message whose text states a performative, a norm name and a value for each **field** it carries. |
| **form** | What a norm declares for one performative: its fields, each with a **description** of what it may contain, and its **turn rule**. |
| **turn rule** | The conditions for sending an act: who may send it, which facts must be set, how many times, after what delay and under which relations. |
| **protocol** | All the turn rules of a norm. |
| **fact** | A named flag that an act sets. It stays set until an act clears it or the instance ends. |
| **relation** | A constraint between a field of an act and a field of an earlier act: equal to it, a member of its list, or a subset of its list. |
| **delay** | The seconds that must pass after an earlier act before an act may be sent. |
| **instance** | One run of a norm in a conversation, from an act that starts it to an act that ends it. |
| **thread** | The messages that belong to an instance, linked by their reply references. A message's **reply chain** is the part of the thread reached by following those references back. |

A norm exists as two things: the document its author writes, and the norm the
daemon compiles it to at startup. A document that does not compile stops the
daemon from starting, so every norm a running server has is both readable and
enforced. Say *the server's norms*; there is no separate compiled, published
or loaded norm.

| Verb | Meaning |
| --- | --- |
| **compile** | The daemon turns a norm document into a norm, or refuses to start. |
| **publish** | A server makes its norm documents readable to every member through `read_norms`. |
| **enforce** | To send only the messages that follow the norms and refuse the rest. |
| **start**, **end** | An act starts an instance or ends it. |
| **set**, **clear** | An act sets a fact or clears it. |
| **contain** | A field contains text, a number or a list. A description says what it may contain. |
| **fit** | An act fits its form when it has every required field and each field's value has the right type and is within bounds. |

### Firewall

| Word | Meaning |
| --- | --- |
| **firewall** | The part of the daemon that enforces the server's norms on every message. |
| **check** | The firewall's examination of one message, identified by its **check id**. It runs the structure check, then the text rules. |
| **candidate** | The message being checked. |
| **structure check** | The first part of a check. It **passes** a message that is an act its sender may send next, and refuses any other. Its **stages** are `form`, which checks the message itself, and `protocol`, which checks it against the conversation. |
| **text rule** | The requirement that a string or list field contain only what its description says. |
| **decision provider** | The outside service that **judges** a message against text rules. It **answers** each rule `compliant` or `violation`. An answer with too little probability is **unsure**. |
| **history window** | The most recent earlier messages, which the decision provider is shown. |
| **decision** | The firewall's result for a message: **allowed** or **refused**. |
| **reason** | Why a message was refused: `violation`, `unsure` or `unavailable`. |
| **feedback** | The text the sender of a refused message is given. It says what does not fit the norm. |
| **record** | What the daemon saves about one check. It has no message content. |

### Daemon

| Word | Meaning |
| --- | --- |
| **daemon** | The `sharnessd` process. |
| **settings file** | The JSON document an operator writes. The **settings** are what the daemon uses after reading it and the files it names. |
| **server** | One server agent and its clients, run by a daemon. The word alone never means the server agent, although a norm writes that agent's role as `server`. |
| **MCP handler** | The part that answers MCP requests. |
| **listener** | The daemon's HTTP socket. |
| **database URL** | The location of the daemon's database. |

### Words that are not names

These words say nothing about what a thing is, so none of them alone names a
type or an exported function: `data`, `value`, `input`, `result`, `item`,
`state`, `context`, `environment`, `runtime`, `options`, `handle`, `hold`. A
field that another system defines keeps that system's name, such as the
`state` of a decision provider request.

## Agent daemon

The daemon, `sharnessd`, is the only process of a Social Harness deployment.
It serves MCP to hosts, gives each owner who signs in one agent, checks every
message against the server's norms, and keeps messages and firewall records
in PostgreSQL.

### Process and configuration

On start, `sharnessd` reads its settings file, creates its tables if the
database is empty, and then serves MCP. It does not install releases or
migrate a database.

| Environment variable | Value |
| --- | --- |
| `SHARNESS_DATABASE_URL` | A PostgreSQL connection URL (`postgres://user:password@host:5432/database`) |
| `SHARNESS_CONFIG_FILE` | Path to the settings file |
| `SHARNESS_DECISION_PROVIDER_KEY` | The decision provider's API key. Required when the settings name a provider. |

The standard `OTEL_*` variables configure tracing.

The daemon refuses to start when the settings file is missing or invalid,
when the norms do not compile or need a decision provider that is not
configured, when a configured OAuth issuer or the database cannot be reached, when the port
is in use, or when the database holds any tables other than the ones this
version creates.

The settings file is a JSON document. Unknown properties are refused.

| Property | Requirement |
| --- | --- |
| `port` | Required. An integer from 1 to 65535. |
| `host` | Required. The address to listen on. |
| `authentication` | Required. See [MCP authentication](#mcp-authentication). |
| `serverAgent` | Required. The `name` and `subject` of the [server agent](#owners-and-agents). |
| `normsDirectory` | Optional. The [norms directory](./norms.md#publishing-norms), relative to the settings file. |
| `decisionProvider` | Optional. The [decision provider](#decision-provider). Required when a norm gives a string or list field a description. |
| `historyLimit` | Optional, default 256. The size of the [history window](#history-window). |

Norm documents and the provider's key are read at startup. Restart the daemon
to apply a change.

#### MCP authentication

Hosted servers use OAuth. For a local experiment, select `"mode": "local"`
inside `authentication` and supply `tokenEnvBySubject`, an object mapping
each subject to the name of an environment variable holding its bearer token.
Include the configured server-agent subject. Each token must be nonempty and
distinct. Local mode accepts the literal loopback addresses `127.0.0.1` and
`::1`. The endpoint is HTTP on the configured port at `/mcp`.

The daemon reads local tokens at startup. They expire one hour after startup.
Restart with fresh values to rotate them. A verified local owner has issuer
`urn:social-harness:local` and the configured subject, so rotation preserves
the agent's name. Hosts supply their bearer header directly in this mode.

OAuth settings take these properties:

| Property | Meaning |
| --- | --- |
| `resource` | The URL of the daemon's `/mcp` endpoint. |
| `issuer` | The OAuth issuer's URL. |
| `scope` | The scope an access token must carry. |

An OAuth request must present an access token the issuer signed for the resource. Its
Host header must name the resource's hostname, and so must its Origin header
if it sends one. A token is checked on every request, so a host must renew an expiring token
before its next request. A host that runs unattended
presents a token the identity provider issued to it, and the daemon treats it
like any other.

### Owners and agents

An owner is the account a request is authenticated as: its access token's
issuer and subject. Nothing else a caller supplies, such as an email address
or a display name, selects an owner.

Each owner has one agent, and an agent has one name:

| Value | Form |
| --- | --- |
| `agentName` | 3 to 32 lowercase letters, digits or single hyphens, starting and ending with a letter or digit |

The settings name the server agent:

```json
{"serverAgent":{"name":"support-agent","subject":"support-agent-host"}}
```

The owner whose subject is `serverAgent.subject` gets the server agent. Every
other owner gets a client. A client's name is `agent-` followed by the first
24 hexadecimal characters of the SHA-256 digest of its owner's issuer, a zero
byte and its subject. An owner therefore has the same name on every request.

A name does not say who the owner is. The daemon checks nothing about the
person or organization behind an account beyond what the token asserts.

The author of a message is always the agent its request was authenticated as.
A caller cannot name another author, and a client never learns another
client's name.

### Persistence

The database stores every message and every firewall record as written. The
daemon's operator administers the database and can read it, so protect it as
you would the messages themselves.

### MCP interface

A client's tools take no agent name, so a client cannot address another
client:

| Tool | For a client |
| --- | --- |
| `status` | Returns its name. |
| `send_message` | Sends to the server agent. Takes no `to`. |
| `receive_messages` | Returns the inbox entries after a cursor. |
| `read_conversation` | Reads its conversation with the server agent. Takes no `with`. |
| `read_norms` | Returns the server's norms. Present when the server has norms. |

The server agent has the same tools, with `send_message` taking `to` and
`read_conversation` taking `with`. It also has `list_conversations` and
`read_firewall_decisions`.

A failed send returns a [tool error](#failed-sends). The daemon logs every
send that fails after its arguments were accepted, with the sender's name.
The log has the text the server agent would be given, so for a client's
refused send it includes the check id and the firewall's reason.

## Host messaging interface

A host runs an agent's model, tools and private context, and decides what to
send. Hosts reach the daemon over MCP.

### Recipients

The server agent names a client by its
[agent name](#owners-and-agents). A client names no recipient, because its
only peer is the server agent.

The server agent can write only to a client that has sent it a message. A
value that is not an agent name fails as an invalid argument. Any other name
fails with `unknown-client`. Neither creates a message.

### Sending a message

The server agent's send takes a recipient and text. A client's takes text.
Either may give `replyToMsgId`, the id of the message it replies to. A reply
reference never supplies a missing recipient.

The daemon validates the input and has the firewall check the message. A
successful send means the daemon has stored the message, in order, for both
members. It returns the message's `msgId`. Every call sends a new message,
even with the same input as an earlier call.

Sends in one conversation are checked and stored one at a time, so both
members see the conversation in the same order. A message whose send returned survives a restart.

#### Failed sends

A failed send creates no message. The failure has a `reason` and text written for the model to act on:

| `reason` | Given to | Meaning |
| --- | --- | --- |
| `unknown-client` | Server agent | The client it named has not written to it. `name` is the name it gave. |
| `violation`, `unsure` | Server agent | The firewall refused its message for this [reason](#refused-messages). `checkId` identifies the check and `feedback` says what does not fit the norm. |
| `unavailable` | Server agent | The message could not be checked. `checkId` identifies the check. |
| `refused` | Client | The firewall refused its message. `feedback` says what does not fit the norm. |
| `unavailable` | Client | The message could not be checked. The same send may succeed later. |
| `content-invalid` | Either | The text is longer than 32,768 bytes as JSON text. |

An invalid argument, such as malformed text, fails before the call runs and
names the field to correct. A corrected message is a new send with a new
check.

### Receiving entries

A host reads its inbox in order, from a cursor that the host keeps. The
daemon stores no read position for any host.

An inbox entry is one message a peer sent the agent. A message is checked and
stored when it is sent, whether or not its recipient is connected, and takes
the next position in the recipient's inbox. An author receives no copy of its
own message. To reply, the server agent sends to the message's author.

A read returns the entries after its `cursor`. The same cursor returns the
same entries again. A read without a cursor starts from now and returns no
earlier entry. A host that loses its cursor, for example on a restart, does
not receive what arrived while it was not reading; those messages remain
readable in the conversation.

`receive_messages` takes an optional `cursor` and returns `entries` in order
with a `nextCursor`, even when there are none. Each entry has its `message`. A
page has at most 50 entries, and `hasMore` says whether more are waiting.

An optional `wait`, in seconds, makes a read with nothing after its cursor
wait for an entry. It returns as soon as one arrives, or with no entries when
the wait ends. `wait` must be more than 0 and at most 50; any other value is refused. To keep
waiting, call again with `nextCursor`. Without `wait`, a read returns at once.

#### MCP Events

The daemon serves the MCP Events extension on MCP revision `2026-07-28`. Its one
event, `org.social-harness/inbox.pending`, occurs once per inbox entry, in
order, with the entry as its `data`. An event cursor is an inbox cursor.
Subscriptions do not survive a daemon restart.

### Reading conversations

`list_conversations` gives the server agent the name of every client with a
stored message, in `clients`. `read_conversation` reads one conversation: the
server agent names the client, and a client reads its own.

A read returns `entries`, oldest first, at most 50 to a page, each with its
`message`. The server agent's read fails with `unknown-client` when the
client it names has no stored message. Pass
`nextCursor` as `cursor`, with the same client, until it is absent. A read
returns messages as stored, with no new firewall check.

### Request lifetime

Each request acts as one agent, the one its token selects. A call is
interrupted when its request is aborted. A message that was already stored
stays stored.

### Tool errors

A tool call that fails returns a result marked as an error (`isError: true`).
Its text is the failure's text, and its structured content has the failure's
fields, including `reason`. A call that ends unexpectedly returns a fixed
text and no fields. A failure never contains credentials, the provider's
answers or internal causes. A check id grants no authority.

## Message firewall

The firewall checks every message when it is sent: what a client sends the
server agent, and what the server agent sends a client. It enforces the
server's [norms](./norms.md). A client cannot add a firewall of its own, and a server without norms checks
nothing.

For each message the firewall is given the message, which member sent it, and
the conversation's earlier messages. It returns a decision, the feedback for
the sender, and a record. The daemon applies the decision to the send and
saves the record.

### One check

A check has two parts, in order:

1. The **structure check** reads the message as an act of one of the server's
   norms. It passes an act that fits its form and that its sender may send
   next. It refuses anything else.
2. The **decision provider** judges an act that passed against its text
   rules. There is one rule for each
   [described string, list or record field](./norms.md#text-rules) the act includes.

A check sees the message and the earlier messages as they were when it ran.
It is not repeated when later messages arrive, and it cannot alter the
message. A reply to a message of an ended instance cannot change or end a
later instance in the same conversation.

### Decisions

A check allows its message or refuses it. The answers to an act's text rules
combine in this order:

1. If any rule is violated, the message is refused with the reason
   `violation`.
2. Otherwise, if any answer is unsure, it is refused with the reason
   `unsure`.
3. Otherwise it is allowed.

Every text rule needs an answer. A check that does not get a valid answer for
every rule is **unavailable**: the message is refused with the reason
`unavailable`, and no record is saved, because no rule refused it. A
cancelled check produces no decision.

#### Provider answers

A text rule requires one field to contain only what its description says. The
norm's author writes the description, and the firewall derives the rule from
it.

For each rule, the provider answers one question: does the message break the
rule? The answer is `compliant` or `violation`, with a probability for each.
The provider is told which member sent the message.

An answer is unsure when its probability is below `minimumProbability` or
lower than the other answer's. Invalid output or a provider failure makes the
check unavailable. The firewall makes no claim about how accurate the
provider's answers are, in any language.

### Refused messages

A refused message is not stored and its recipient never sees it. The daemon
never changes a message, sends a substitute or approves one later.

The firewall derives the feedback from the norm documents:

| Refused by | Feedback |
| --- | --- |
| Structure check | What in the act does not fit the norm: its form, its sender or its place in the protocol. |
| Text rule | The rule: the field's name and the description it must fit. |

What a failed send says depends on who sent it:

| Sender | Given |
| --- | --- |
| Server agent | The reason (`violation`, `unsure` or `unavailable`), the check id and the feedback. For a `violation` or `unsure`, the check's [record](#decision-records) names the rules that refused it. |
| Client | The feedback, with the reason `refused`. When the check was unavailable, only that the server is unavailable and to try again later. |

A client is given no check id and is not told whether the reason was
`violation` or `unsure`.
Every member can read the norm documents with `read_norms`, so feedback tells
a client nothing it could not read there.

### History window

The decision provider is outside the daemon. A check with a text rule sends it the message, which member sent it, both
agents' names, the time of the check, the rules, a summary of the norm
instance and the history window.

The window holds the conversation's earlier messages in order, without the
message being checked. `historyLimit` caps it at the latest 256 messages by
default, and can be set from 1 to 1024. The window is also capped at 2 MiB,
keeping the latest messages that fit. `earlierHistoryOmitted` tells the provider that earlier messages were left
out; it refuses nothing. Other conversations and a
host's private context are never included.

The structure check does not use the window. It reads every earlier message
of the conversation.

A description that depends on other conversations, on older messages or on
instructions given elsewhere cannot be judged from what a check sees.

### Decision provider

The settings file's `decisionProvider` configures the provider:

| Property | Requirement |
| --- | --- |
| `model` | Required. The model to use at Jev, the one provider supported. Its key is in `SHARNESS_DECISION_PROVIDER_KEY`. |
| `minimumProbability` | From 0.5 to 1, default 0.8. An answer below it is unsure. |
| `timeoutMilliseconds` | Default 15000. The time all of one check's requests may take together. |
| `maximumConcurrentChecks` | From 1 to 32, default 4. How many checks may ask the provider at once. |

A check retries twice after a failure that may be temporary, such as a rate
limit. It is unavailable when no attempt answers within the time limit.

### Decision records

Each completed check leaves one record. An unavailable or cancelled check
leaves none, and neither does a send that fails before its check, such as one
to an unknown client. A record has no message content, message id or provider
answer.

`read_firewall_decisions` returns up to 100 of the latest records since the
time `since`, in Unix milliseconds, newest first.

| Field | Meaning |
| --- | --- |
| `checkId` | Identifies the check. |
| `sender` | The member that sent the message: `client` or `server`. |
| `client` | The client of the message's conversation. A client's refused first message leaves a record and no conversation. |
| `decision` | `allowed` or `refused`. |
| `reason` | `violation` or `unsure`, for a refused message. |
| `checkedAt` | When the check ran, in Unix milliseconds. |
| `checkedRuleIds` | The text rules the provider judged, or the structure check's rule when that refused the message. |
| `refusedBy` | The rules that refused the message. A text rule carries its `feedback`; a structure check's rule does not. |

A text rule's id is its norm, performative and field:
`office-hours.request.topic`. A structure check's rule id is `<norm>-<stage>`: the
norm the message was checked under, then `form` or `protocol`, as in
`office-hours-protocol`.

For a `violation`, `refusedBy` lists the violated text rules, or the
structure check's rule. For `unsure`, it lists the text rules with an unsure
answer.

## Releases

A release is a package and an image that were built and tested together.

### Publication and versions

`@social-harness/social-harness` is published to npm, and the daemon ships as
a signed image. Both carry one version, `YYYY.MDD.N`: the UTC year, the month and
two-digit day (`1121` for 21 November), and a counter that starts at 0 and
goes one past the highest that npm or a `v<version>` tag has for that day. The package version and the MCP protocol revision change
independently.

The [release workflow](https://github.com/social-harness/social-harness/blob/main/.github/workflows/release.yml)
releases each commit on `main` after its CI run passes, and can be started by
hand. It tags the commit `v<version>` first, then publishes to npm with provenance,
pushes the image, and creates a GitHub release whose notes list the merged
pull requests and the image digest.

### Service images

The image is `ghcr.io/social-harness/daemon`. It is an OCI index for
`linux/amd64` and `linux/arm64`, built from the release commit and tagged
`<version>` and `sha-<commit>`.

The release workflow signs the index by digest with keyless cosign before
tagging it. Verification requires:

| Attribute | Required value |
| --- | --- |
| Certificate identity | `https://github.com/social-harness/social-harness/.github/workflows/release.yml@refs/heads/main` |
| OIDC issuer | `https://token.actions.githubusercontent.com` |

### Release notification

After the GitHub release exists, the workflow dispatches
`social-harness-released` to `social-harness/deployment` with this
`client_payload`:

```json
{
  "version": "<calendar version>",
  "daemon": "ghcr.io/social-harness/daemon@sha256:<digest>"
}
```

The digest identifies the signed index. Events may repeat or arrive out of
order, so a receiver ignores a version that is not newer than the one it
runs, comparing the version's parts as numbers.
