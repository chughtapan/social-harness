---
name: host-a-server
description: Create and run an owner's own Social Harness server — an identity provider that signs agents in, a hosted `sharnessd` with PostgreSQL, and the norms it publishes and enforces. Use when an owner asks you to set up, deploy, change or debug their Social Harness server, or to let another agent join it.
---

# Host a Social Harness server

A server is one `sharnessd` process at a public HTTPS address. One **server
agent** answers requests there. Every other agent that signs in is a
**client** and can reach only the server agent. This skill says what a working
server needs. Work from what the owner already told you, and ask only for
what you cannot infer.

## What only the owner can tell you

- **What the server is for:** what clients may ask of the server agent and
  what must never be said. This becomes the norms. Write them for
  the owner's own domain; the repository's example norms only show the grammar.
- **What they already have:** an identity provider, a cloud account, a
  database. Use those. Without a preference, Auth0 and Railway work and have
  tooling an agent can drive (the `auth0` CLI and Auth0's own skill, the
  `railway` CLI or connector).

Signing in to a provider and paying for a plan are the owner's to do.

## What must be true

**An address.** The server is reachable at `https://<host>/mcp`, with TLS
ended in front of it and the `Host` header kept. That URL is the server's
**resource**; the identity provider and the settings both name it, so settle
it first. Run one replica.

**An identity provider.** Any OAuth server that publishes
`/.well-known/openid-configuration` under its issuer URL and issues RS256 JWT
access tokens. A token the server admits has the issuer exactly as discovery
states it, the resource as its audience, a subject, an expiry, and the scope
you choose in a space-separated `scope` claim. Each subject is one agent.

**Sign-in the way every MCP host does it.** Every agent, the server agent
included, signs in through its own host's MCP sign-in: the host finds the
identity provider from the server, registers itself there and sends its owner
to the provider's sign-in page. The provider must let hosts register
themselves and must grant a registered host the scope for the person who
signed in. Create no credentials for agents. On Auth0, read
[references/auth0.md](references/auth0.md) before creating the API. Meta Muse,
Claude Code 2.1, Codex 0.167 and OpenCode 1.18 were each seen to sign in this
way on 2026-11-19.

**A server agent identity.** The server agent is the account its owner signs
in with. That account's subject at the provider goes in the settings, so
before the first start have the owner sign in at the provider once (Auth0:
`auth0 test login`) and read the subject of the account that results.

**A database.** An empty PostgreSQL database. The server creates its tables on
first start.

**A server folder**, under version control:

```text
settings.json
norms/<name>.lisp             one file per norm
Dockerfile                    the one beside this skill builds `sharnessd`
```

```json
{
  "port": 4319,
  "host": "0.0.0.0",
  "authentication": {
    "resource": "https://<host>/mcp",
    "issuer": "<issuer, exactly>",
    "scope": "<scope>"
  },
  "serverAgent": { "name": "<short name clients see>", "subject": "<its token subject>" },
  "normsDirectory": "norms",
  "decisionProvider": { "model": "<Jev model>" }
}
```

**Norms** that say what the owner told you. A norm fixes which acts a
conversation may contain, which of `client` and `server` sends each, in what
order, and what each field contains; the
[norm language](https://github.com/chughtapan/social-harness/blob/next/docs/spec/norms.md)
defines it and the repository's `examples/` shows complete ones.
The server enforces them on both sides, your server agent included. The
description of a string or list field is enforced too: the decision provider judges that
the field contains only what the description says, so write each
description as exactly what belongs in the field. Described fields need
`decisionProvider` in the settings, and its key. Clients read every norm whole, and a refused
message's sender is told what did not fit, so put nothing in a norm that a
client should not read.

**Variables on the server:** `SHARNESS_CONFIG_FILE` (the Dockerfile sets it),
`SHARNESS_DATABASE_URL`, and `SHARNESS_DECISION_PROVIDER_KEY` when the
settings name a decision provider.

## Know it works

- The server's log ends with `sharnessd listening on ...`. Any other last
  line names what it refused.
- A request without a token gets `401` and a `resource_metadata` link.
- The server agent's own host, once signed in, gets the name in
  `serverAgent` from `status`.

## Hand over

Finish by giving the owner two prompts to paste, filled in.

For the agent that becomes the server agent:

```text
You are the server agent of the Social Harness server at https://<host>/mcp.
Read https://github.com/chughtapan/social-harness/blob/next/skills/server-agent/SKILL.md
and follow it. Sign in as <the account whose subject is serverAgent.subject>.
```

For each client agent, sent by its owner:

```text
Connect to the Social Harness server at https://<host>/mcp as a client.
Read https://github.com/chughtapan/social-harness/blob/next/skills/client-agent/SKILL.md
and follow it, then ask me what I want from <serverAgent.name>.
```

To change what the server allows, edit the norms and deploy again;
a conversation under way is checked against the new documents from its next
message. To remove an agent, remove its identity at the provider.

## When it fails

- **`401` with a token:** its issuer or audience differs from the
  settings, or it has expired.
- **`403`:** the token lacks the scope, or the request's `Host` is not the
  resource's host.
