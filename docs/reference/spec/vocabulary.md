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
| **agent** | What the daemon hosts for one owner. |
| **agent name** | How messages name an agent: the server agent's configured name, or the name the daemon derives for a client from its owner. |
| **host** | The program connected to the daemon over MCP on an agent's behalf. |

## Messages

Everything one agent sends another is a **message**. There is no second kind
of thing.

| Word | Meaning |
| --- | --- |
| **message** | Text from one **author** to one **recipient**, identified by its **message id** (`msgId`). |
| **conversation** | The messages exchanged between its two **members**. Each member is the other's **peer**. |

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
| **norm document** | The text that states one norm, in the [norm language](./norms/norms.md). |
| **act** | A message's text when it states a **performative**, the norm it belongs to and a value for each **field** it carries. |
| **form** | What a norm declares for one performative: the fields an act of it carries, each with the **description** of what it contains, and its turn rule. |
| **fact** | A name that is set or not during an instance. |
| **role** | Which member of a conversation an agent is: `client`, or `server` for the server agent. A message's **sender** is the role of its author. |
| **protocol** | A norm's turn rules: which role may send which act next. |
| **instance** | One run of a norm's protocol in a conversation, from an act that starts it to an act that ends it. |
| **thread** | The messages that belong to an instance, linked by their reply references. |

A norm has these verbs and no others:

| Verb | Meaning |
| --- | --- |
| **compile** | The daemon compiles a norm document into a norm, or refuses to start. |
| **publish** | A server publishes its norms: every member reads them with `read_norms`. |
| **enforce** | The firewall enforces the published norms on every message. |
| **start**, **end** | An act starts an instance or ends it. |
| **set**, **clear** | An act sets a fact or clears it. |
| **contain** | A field contains a value, and a description says what it may contain. |

## Firewall

| Word | Meaning |
| --- | --- |
| **firewall** | What enforces the published norms on every message of the server agent's conversations when it is sent. |
| **check** | What the firewall does with one message when it is sent, identified by its **check id**: the structure check, then the text rules. |
| **candidate** | The message under check. The messages stored before it in its conversation are the **earlier** messages. |
| **structure check** | The first part of a check: it **passes** a message whose text is an act its sender may send next, and refuses any other. Its two **stages** are `form`, which reads the message alone, and `protocol`, which reads the conversation. |
| **text rule** | The requirement that a string or list field contain only what its description says. |
| **decision provider** | The service that **judges** a message against text rules. It **answers** each one compliant or violation, and an answer it gives too little probability is **unsure**. |
| **decision** | What the firewall decides for a message, whichever member sent it: it is **allowed** or **refused**. |
| **reason** | Why a message was refused: rule-violation, unresolved-evidence or check-unavailable. |
| **feedback** | What the sender of a refused message reads: what in it does not fit the norm. The firewall derives it. |
| **record** | What the server saves of one check's decision, without message content. |

The structure check passes a message or refuses it. The decision provider
judges and answers. The firewall checks, and decides to allow or refuse.

## Daemon

| Word | Meaning |
| --- | --- |
| **daemon** | The `sharnessd` process. |
| **settings file** | The JSON document an operator writes. **Settings** are what the daemon uses once it has read that file and the files it names. |
| **server** | What a daemon runs for its agents: one server agent and its clients. |
| **server agent**, **client** | The two roles an agent has. The settings name the server agent, and every other agent is a client. |
| **MCP handler** | Answers each MCP request from the agent of the owner the request is admitted as. |
| **listener** | The daemon's one HTTP socket. |
| **database URL** | Where the daemon's database is. |

## Words that are not names

These words say nothing about what a value is. They name a value only when no
word above fits, and never a type or an exported function: `data`, `value`,
`input`, `result`, `item`, `state`, `context`, `environment`, `runtime`,
`options`, `handle`, `hold`.
