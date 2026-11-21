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

## Inbox

| Word | Meaning |
| --- | --- |
| **inbox** | What one agent has received. |
| **inbox entry** | One message as the host reads it. |
| **cursor** | A place in an inbox or a conversation, in the order its messages were stored. A read returns what follows it. |

## Firewall

| Word | Meaning |
| --- | --- |
| **firewall** | What holds every message of the server agent's conversations to the held norms when it is sent. |
| **check** | One evaluation of one message against the held norms, identified by its **check id**. |
| **text rule** | The requirement that a string or list field hold what its description says and nothing else, which the **decision provider** judges. |
| **decision provider** | The service that answers whether a message breaks a text rule. |
| **decision** | What the firewall tells the daemon to do with a message, whichever member sent it: it is **allowed** or **refused**. |
| **reason** | Why a check decided as it did: eligible, rule-violation or unresolved-evidence. A message whose check could not run is refused as check-unavailable. |
| **feedback** | What the sender of a refused message reads: what in it does not fit the norm. The firewall derives it. |
| **evidence** | The conversation history a check may read. |

## Norms

| Word | Meaning |
| --- | --- |
| **norm** | Which **acts** the client and the server agent may send each other, in what order and with what in each field, identified by its **norm name**. A server publishes its norms. |
| **norm document** | The text that defines one norm, in the [norm language](./norms/norms.md). |
| **act** | A message's text when it is a FIPA ACL act: a **performative** and its parameters. |
| **form** | What a norm declares for one performative: the fields an act of it carries, each with the **description** of what it holds, and its turn rule. |
| **fact** | A name that holds or does not hold during an instance. Acts set and clear facts, and forms wait on them. |
| **role** | Which member of a conversation an agent is. A norm document writes the roles `client` and `server`, the server agent. |
| **protocol** | A norm's turn rules: which role may send which act next. |
| **instance** | One run of a norm's protocol in a conversation. |
| **held norms** | The norms a server publishes and its firewall applies. |
| **structure check** | The part of a firewall that holds each message to the held norms' forms and protocols, before the text rules judge it. |

## Daemon

| Word | Meaning |
| --- | --- |
| **daemon** | The `sharnessd` process. |
| **settings file** | The JSON document an operator writes. **Settings** are what the daemon holds after it has read that file and the files it names. |
| **server** | What a daemon runs for its agents: one server agent and its clients. |
| **server agent**, **client** | The two roles an agent has. The settings name the server agent, and every other agent is a client. |
| **MCP handler** | Answers each MCP request from the agent of the owner the request is admitted as. |
| **listener** | The daemon's one HTTP socket. |
| **database URL** | Where the daemon's database is. |

## Words that are not names

These words say nothing about what a value is. They name a value only when no
word above fits, and never a type or an exported function: `data`, `value`,
`input`, `result`, `item`, `state`, `context`, `environment`, `runtime`,
`options`, `handle`.
