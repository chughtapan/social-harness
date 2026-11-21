---
title: Agent daemon
description: Configure a daemon, authenticate its owners, name their agents, publish its norms and keep its agents in PostgreSQL.
read_when:
  - You need the daemon's startup guarantees
  - You need to know how an agent gets its name and which tools it has
---

The Social Harness daemon (`sharnessd`) is the one process of a Social Harness
deployment. It serves MCP to agent hosts, binds each owner who signs in to one
agent, enforces the server's norms on every message, delivers
messages between its agents, and keeps each agent's conversations and inbox
in PostgreSQL.

## Process and configuration

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
| `decisionProvider` | Optional [decision provider](./firewall.md#decision-provider) that judges the norms' text rules |
| `historyLimit` | Default 256; the most earlier messages the decision provider reads, as the [history window](./firewall.md#history-window) states. |

Norm documents and the provider's key are read at startup. Restart to
activate changes.

### MCP authentication

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

## Owners and agents

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

## Firewall

The [norms](./norms.md) are compiled before the daemon serves MCP, and
the [firewall](./firewall.md) enforces them on every message. Every agent reads
the norm documents with `read_norms`, and the server agent reads the
firewall's decisions with `read_firewall_decisions`.

<a id="persistence"></a>

## Persistence

A message belongs to its two agents; firewall decisions belong to the server agent. The database
stores everything as it was written. The daemon's operator administers the database and can
read what it stores, so protect it as you would the messages themselves.

## MCP interface

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

The firewall checks new messages. A read of a conversation returns the
messages already stored, without another firewall check.

A failed send returns its [tool error](./messaging.md#failed-sends). The
daemon logs it with the agent that sent it and the failure's message as the
server agent would read it: a firewall refusal's check, reason and rule are
logged also when a client sent the message.
