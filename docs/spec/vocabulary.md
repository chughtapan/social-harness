---
title: Vocabulary
description: The one word Social Harness uses for each thing, in code, tools and documentation.
read_when:
  - You are naming a type, a field, a function or a tool argument
  - Two words in the code or the docs seem to mean the same thing
---

Each thing has one word. Code, tool contracts, error text and documentation
use that word and no other. A new concept gets its word here before it gets a
name in code.

## Agents

| Word | Meaning |
| --- | --- |
| **owner** | The account that signs in to the daemon, identified by an issuer and a subject. |
| **agent** | What sends and receives messages for one owner. The **server agent** is the one the settings name, and every other agent is a **client**. |
| **agent name** | How messages name an agent: the server agent's configured name, or the name the daemon derives for a client from its owner. |
| **host** | The program connected to the daemon over MCP on an agent's behalf. |

## Messages

Everything one agent sends another is a **message**. There is no second kind
of thing.

| Word | Meaning |
| --- | --- |
| **message** | Text from one **author** to one **recipient**, both agent names, identified by its **message id** (`msgId`). |
| **conversation** | The messages exchanged between its two **members**: a client and the server agent. Each member is the other's **peer**. |
| **role** | Which member of a conversation an agent is: `client`, or `server` for the server agent. |
| **sender** | The member that sends a message, named by its role. A message's author is an agent name, and its sender is a role. |
| **earlier messages** | The messages stored before a message in its conversation. |

## Reading messages

| Word | Meaning |
| --- | --- |
| **inbox** | What one agent has received. |
| **entry** | One message as a host reads it, from an inbox or a conversation. |
| **page** | The entries one read returns. |
| **cursor** | A place in an inbox or a conversation, in the order its messages were stored. A read returns what follows it. |

## Norms

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

## Firewall

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

## Daemon

| Word | Meaning |
| --- | --- |
| **daemon** | The `sharnessd` process. |
| **settings file** | The JSON document an operator writes. **Settings** are what the daemon uses once it has read that file and the files it names. |
| **server** | What a daemon runs for its agents: one server agent and its clients. The word alone never means the server agent, though a norm writes that agent's role as `server`. |
| **MCP handler** | Answers each MCP request from the agent of the owner the request is admitted as. |
| **listener** | The daemon's one HTTP socket. |
| **database URL** | Where the daemon's database is. |

## Words that are not names

These words say nothing about what a thing is. On their own they name no type
and no exported function: `data`, `value`, `input`, `result`, `item`,
`state`, `context`, `environment`, `runtime`, `options`, `handle`, `hold`. A
field that another system defines keeps that system's name, such as the
`state` of a decision provider request.
