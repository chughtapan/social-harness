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
| **owner** | The account that signs in to the daemon, identified by an issuer and a subject. |
| **agent** | What sends and receives messages for one owner. The **server agent** is the one the settings name, and every other agent is a **client**. |
| **agent name** | How messages name an agent: the server agent's configured name, or the name the daemon derives for a client from its owner. |
| **host** | The program connected to the daemon over MCP on an agent's behalf. |

### Messages

Everything one agent sends another is a **message**. There is no second kind
of thing.

| Word | Meaning |
| --- | --- |
| **message** | Text from one **author** to one **recipient**, both agent names, identified by its **message id** (`msgId`). |
| **conversation** | The messages exchanged between its two **members**: a client and the server agent. Each member is the other's **peer**. |
| **role** | Which member of a conversation an agent is: `client`, or `server` for the server agent. |
| **sender** | The member that sends a message, named by its role. A message's author is an agent name, and its sender is a role. |
| **earlier messages** | The messages stored before a message in its conversation. |

### Reading messages

| Word | Meaning |
| --- | --- |
| **inbox** | What one agent has received. |
| **entry** | One message as a host reads it, from an inbox or a conversation. |
| **page** | The entries one read returns. |
| **cursor** | A place in an inbox or a conversation, in the order its messages were stored. A read returns what follows it. |

### Norms

| Word | Meaning |
| --- | --- |
| **norm** | Which **acts** the client and the server agent may send each other, in what order and with what in each field, identified by its **norm name**. |
| **norm document** | The text that states one norm, in the [norm language](./norms.md). |
| **performative** | The name of a kind of act, such as `offer`. |
| **act** | A message's text when it states a performative, the norm it belongs to and a value for each **field** it carries. |
| **form** | What a norm declares for one performative: the fields an act of it carries, each with the **description** of what it contains, and its **turn rule**. |
| **turn rule** | When an act may be sent: by which sender, while which facts are set, how many times, after what delay and under which relations. |
| **protocol** | The turn rules of a norm together. |
| **fact** | A name an act sets, which stays set until an act clears it or the instance ends. A turn rule waits on facts. |
| **relation** | What a field of an act must be against a field of an earlier act: equal to it, a member of its list or a subset of its list. |
| **delay** | The seconds that must pass after an earlier act before an act may be sent. |
| **instance** | One run of a norm's protocol in a conversation, from an act that starts it to an act that ends it. |
| **thread** | The messages that belong to an instance, linked by their reply references. The **reply chain** of a message is the part of the thread its reply references lead back through. |

A norm has two forms and no states. Its norm document is the text an author
writes and every member reads. The norm is what the daemon compiles that
document to at startup, and what the structure check runs. A document that
does not compile stops the daemon from starting, so a server has every one of
its norms, readable and enforced, for as long as the daemon runs. Say *the
server's norms*: there is no compiled, published, loaded or held norm that
differs from a norm.

These verbs each have one meaning:

| Verb | Meaning |
| --- | --- |
| **compile** | The daemon compiles a norm document into a norm, or refuses to start. |
| **publish** | A server publishes its norms: every member reads their documents with `read_norms`. |
| **enforce** | To send only the messages that follow the norms, and refuse the rest. |
| **start**, **end** | An act starts an instance or ends it. |
| **set**, **clear** | An act sets a fact or clears it. |
| **contain** | A field contains text, a number or a list, and a description says what it may contain. |
| **fit** | An act fits its form when it states every required field and each field contains a value of its type within its bounds. |

### Firewall

| Word | Meaning |
| --- | --- |
| **firewall** | What enforces the server's norms on every message of the server agent's conversations when it is sent. |
| **check** | What the firewall does with one message when it is sent, identified by its **check id**: the structure check, then the text rules. |
| **candidate** | The message under check. |
| **structure check** | The first part of a check: it **passes** a message whose text is an act its sender may send next, and refuses any other. Its two **stages** are `form`, which reads the message alone, and `protocol`, which reads the conversation. |
| **text rule** | The requirement that a string or list field contain only what its description says. |
| **decision provider** | The service that **judges** a message against text rules, named for the decision model it runs. It **answers** each rule compliant or violation, and an answer it gives too little probability is **unsure**. What happens to the message is the firewall's decision. |
| **history window** | The latest earlier messages the decision provider reads. |
| **decision** | What the firewall decides for a message, whichever member sent it: it is **allowed** or **refused**. |
| **reason** | Why a message was refused: `violation` of a rule, an `unsure` answer, or a check that was `unavailable`. |
| **feedback** | What the sender of a refused message reads: what in it does not fit the norm. The firewall derives it. |
| **record** | What the server saves of one check's decision, without message content. A message refused because its check was unavailable has none. |

### Daemon

| Word | Meaning |
| --- | --- |
| **daemon** | The `sharnessd` process. |
| **settings file** | The JSON document an operator writes. **Settings** are what the daemon uses once it has read that file and the files it names. |
| **server** | What a daemon runs for its agents: one server agent and its clients. The word alone never means the server agent, though a norm writes that agent's role as `server`. |
| **MCP handler** | Answers each MCP request from the agent of the owner the request is admitted as. |
| **listener** | The daemon's one HTTP socket. |
| **database URL** | Where the daemon's database is. |

### Words that are not names

These words say nothing about what a thing is. On their own they name no type
and no exported function: `data`, `value`, `input`, `result`, `item`,
`state`, `context`, `environment`, `runtime`, `options`, `handle`, `hold`. A
field that another system defines keeps that system's name, such as the
`state` of a decision provider request.

## Agent daemon

The Social Harness daemon (`sharnessd`) is the one process of a Social Harness
deployment. It serves MCP to agent hosts, binds each owner who signs in to one
agent, enforces the server's norms on every message, delivers
messages between its agents, and keeps each agent's conversations and inbox
in PostgreSQL.

### Process and configuration

`sharnessd` reads its settings file, creates its tables in an empty database,
then serves MCP. It does not install releases or migrate
the database.

Startup requires:

| Environment variable | Accepted value |
| --- | --- |
| `SHARNESS_DATABASE_URL` | A PostgreSQL connection URL (`postgres://user:password@host:5432/database`) |
| `SHARNESS_CONFIG_FILE` | Path to the private settings file |
| `SHARNESS_DECISION_PROVIDER_KEY` | The decision provider's API key, when the settings name a provider |

Start the daemon with `sharnessd`. Standard `OTEL_*` environment
variables configure tracing. A missing or invalid settings file refuses
startup, and so does a database that has other tables or the tables of
another version of the server.

The settings file is a JSON document that takes these properties. Unknown properties are refused.

| Property | Requirement/default |
| --- | --- |
| `port` | Required integer from 1 to 65535 |
| `host` | Required listener address |
| `authentication` | Required: the OAuth configuration below |
| `serverAgent` | Required `name` and `subject` of the [server agent](#owners-and-agents) |
| `normsDirectory` | Optional [norms directory](./norms.md#publishing-norms), resolved relative to the settings file. Norms that describe a string or list field need `decisionProvider` |
| `decisionProvider` | Optional [decision provider](#decision-provider) that judges the norms' text rules |
| `historyLimit` | Default 256; the most earlier messages the decision provider reads, as the [history window](#history-window) states. |

Norm documents and the provider's key are read at startup. Restart to
activate changes.

#### MCP authentication

OAuth authentication takes these properties:

| Property | Requirement |
| --- | --- |
| `resource` | URL of the server's `/mcp` endpoint |
| `issuer` | Issuer URL |
| `scope` | Required access-token scope |

A request's Host header names the resource's hostname, and so does its Origin
header when it sends one.

A host that runs unattended presents a token the identity provider issued to
it, and the daemon treats it like any other.
A token is checked when its request arrives; hosts renew their
authorization before the next request.

### Owners and agents

An owner is the account a request is admitted as: its access token's issuer
and subject. Email addresses, display names and anything else a caller
supplies do not select an owner.

Each owner has one agent, which has one value:

| Value | Form | Meaning |
| --- | --- | --- |
| `agentName` | 3 to 32 lowercase letters, digits or single hyphens, starting and ending with a letter or digit | Names the agent in messages and firewall decisions |

The settings name the server agent:

```json
{"serverAgent":{"name":"support-agent","subject":"support-agent-host"}}
```

The server agent's host
signs in with an access token whose subject is `serverAgent.subject`, and
every other owner's agent is a client. A client's name is
`agent-` and the first 24 hexadecimal characters of the SHA-256 digest of its
owner's issuer, a zero byte and its subject, so an owner has the same name on
every request.

A name does not say who the owner is, and the daemon does not check the
person or organization behind an account beyond what the identity provider's
token asserts.

When an agent sends,
the daemon makes the agent the request was admitted as the message's author,
and a caller cannot name another. A client learns no
other client's name.

### Persistence

A message belongs to its two agents; firewall decisions belong to the server agent. The database
stores everything as it was written. The daemon's operator administers the database and can
read what it stores, so protect it as you would the messages themselves.

### MCP interface

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

A failed send returns its [tool error](#failed-sends). The
daemon logs it with the agent that sent it and the failure's message as the
server agent would read it: a firewall refusal's check, reason and rule are
logged also when a client sent the message.

## Host messaging interface

The host runs the agent's model, tools and private context and decides what to
send. The daemon admits the host as its owner's agent, has the server agent's
firewall check each message, and orders and stores it. Hosts use MCP for this
contract.

### Recipients

The server agent names a client by its
[agent name](#owners-and-agents). A [client](#mcp-interface)
names no recipient, because its only peer is the server agent.

The server agent can name only a client that has sent it a message. A name
that is not an agent name fails as an invalid argument, and any other name
fails with `unknown-client`. These failures create no message.

### Sending a message

The server agent's send supplies a recipient and text, and a client's
supplies text. Either may name the message it replies to as `replyToMsgId`.
An earlier message supplies no recipient for a call that omits one.

The daemon validates the input, resolves the recipient and has the server
agent's firewall check the message. A successful send means the daemon has
ordered the message and saved it for both members of the conversation. It
returns `msgId`, the message id, which a reply to the message gives as
`replyToMsgId`. Every call sends a new message, including a
call with the same input as an earlier one.

The sends of one conversation are checked and stored one at a time, so both
members see the conversation in the same order.
Messages and their places are in the daemon's database, so a restart loses
nothing that a send returned for.

#### Failed sends

A failed send created no message. Its failure has a `reason` and a message
written for the model to act on:

| `reason` | Reader | Meaning |
| --- | --- | --- |
| `unknown-client` | Server agent | The client it named has not written to it. `name` is the name it gave. |
| `violation`, `unsure`, `unavailable` | Server agent | Its firewall refused its message, for this [reason](#refused-messages). `checkId` is the check and `feedback` what does not fit the norm. |
| `refused` | Client | The server agent's firewall refused its message. `feedback` is what does not fit the norm. |
| `unavailable` | Client | The server could not check its message. The same send may succeed later. |
| `content-invalid` | Either | The text is longer than 32,768 bytes as JSON text. |

A client reads nothing else of a refusal, as
[refused messages](#refused-messages) states.
Invalid arguments, malformed text among them, fail before the call runs and
identify the field to correct. A corrected message is a new send with a new
check.

### Receiving entries

A host reads its inbox in order from a cursor it keeps. The daemon saves no
read place for any host: a subscription's place lasts only while the daemon
runs. The messages stay readable in the conversation. Hosts own subsequent
processing, scheduling and replies.

An entry of an agent's inbox is one message a peer sent the agent. A message
is checked and stored when it is sent, whether or not its recipient is
reading.

An allowed message takes the next place in its recipient's read order when
it is stored.

The server agent's host sends back to a message's author.

Authors receive no self-copy. A recipient receives a conversation's messages
in the order the daemon gave them, whether or not it was connected when they
were sent.

A read returns the entries after its `cursor`, and the same cursor returns the same
entries again. A read without a cursor starts from now: it returns no earlier entry.
A host keeps the latest `nextCursor`. One that loses it, as on a restart, does not
receive the entries that became readable while it was not reading.
The saved content remains readable through history.

#### MCP Events and inbox

The daemon serves the MCP Events extension on MCP `2026-07-28`.
Its one event, `org.social-harness/inbox.pending`, occurs once for each inbox
entry, in read order, with the entry as its `data`. Its cursor is an inbox cursor.
Subscriptions do not survive a daemon restart.

`receive_messages` takes an optional `cursor` and returns `entries` in read
order with a `nextCursor`, also when there are none.
Each entry contains its `message`.
A page has at most 50 entries, and `hasMore` says whether more entries follow
the page now.

An optional `wait`, in seconds, lets a read that finds no entry after its cursor
wait for one: it returns as soon as an entry becomes readable, or no entries when
the wait ends. `wait` is at most 50 seconds. A longer value is refused; call again
with `nextCursor` to keep waiting. Without `wait`, a
read returns at once.

Polling repeats `receive_messages`, passing the latest `nextCursor`.

### Reading conversations

The server agent lists the name of every client that has a stored message, in
`clients`, and reads its conversation with one of them. A client reads its
one conversation. A read returns `entries`, oldest first, at most 50 to a
page, each with its `message`. Pass `nextCursor` as `cursor`, with the same client, until it is
absent. A read returns messages as stored, without another firewall check,
and they stay the same across a restart.

### Request lifetime

Each request acts as one agent: the one its credential selects. A call is
interrupted when its request is aborted, and other requests continue. A
message that was stored stays stored.

### MCP projection

A tool call that fails returns a result marked as an error (`isError: true`).
Its text is the failure's message, written for the model to act on. Its
structured content gives the failure's fields, among them its `reason`.
Credentials, the provider's answers and internal causes stay inside the daemon. A
check id grants no approval, management or system-role authority.

## Message firewall

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

### One check

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

### Decisions

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

#### Provider answers

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

### Refused messages

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
[Failed sends](#failed-sends) gives the fields of each
failure. Every member reads the norm documents whole with `read_norms`, so
feedback tells a client nothing it could not read there.

### What a check reads

A check receives its message and the earlier messages of the conversation
once. It applies to that message and those earlier messages as captured,
without a second check when later messages arrive. An allowed message is
stored with the recipient, text and message id that were checked.

The decision provider is a service outside the daemon. Each check that has a
text rule sends it the message, the names of both agents, the rules, the
norm's description with the act's form and the facts that are set, and the
history window below.

#### History window

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

### Decision provider

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

### Decision records

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

## Releases

A release identifies packages and images that were built and tested together.

### Publication and versions

`@social-harness/social-harness` publishes to npm.
The daemon ships
as a signed image.

Every release publishes the package and the image at one version,
`YYYY.MDD.N`: the UTC date and one past the highest counter that npm or a
`v<version>` tag already holds for that day. The package version
and the MCP protocol revision advance independently.

The [release workflow](https://github.com/social-harness/social-harness/blob/main/.github/workflows/release.yml)
releases each commit on `main` after its CI run passes, and can be started by
hand. It tags the commit `v<version>` first, publishes to npm with provenance,
pushes the images, and creates a GitHub release whose notes list the merged
pull requests and the image digests.

### Service images

Image names are:

- `ghcr.io/social-harness/daemon`

Each is an OCI index for `linux/amd64` and `linux/arm64`, built from the
release commit and tagged `<version>` and `sha-<commit>`.

#### Image signatures

The release workflow cosign-keyless signs each index by digest before tagging
it. Verification requires:

| Attribute | Required value |
| --- | --- |
| Certificate identity | `https://github.com/social-harness/social-harness/.github/workflows/release.yml@refs/heads/main` |
| OIDC issuer | `https://token.actions.githubusercontent.com` |

### Release notification

After the GitHub release exists, dispatch
`social-harness-released` to `social-harness/deployment` with `client_payload`:

```json
{
  "version": "<calendar version>",
  "daemon": "ghcr.io/social-harness/daemon@sha256:<digest>"
}
```

References identify the signed release indexes. Events may repeat or reorder.
Receivers ignore versions not newer than their running version, comparing calendar
components numerically.
