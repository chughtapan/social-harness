---
name: setup-server
description: Sets up a Social Harness server and shows an owner how it works. Use when an owner asks to try Social Harness, see how norms work, or set up, deploy, change or debug their own Social Harness server.
---

# Set up a Social Harness server

A Social Harness server connects one **server agent** to many **client**
agents. Each client talks only to the server agent. The server publishes
**norms**: which messages each side may send, in what order, and what each
may contain. It refuses a message that breaks them, from either side.

Read `docs/spec.md` for the settings file and environment variables, and
`docs/norms.md` for the norm language.

## Show the owner how it works

Run a server on the owner's machine and walk them through it. Explain each
step as you do it, and let the owner choose what to try.

1. **Read a norm together.** `examples/meetings/` holds norms for arranging
   a meeting, each a different procedure. Pick one with the owner, or write
   one for something they care about, and say what it allows.
2. **Start a server.** `examples/meetings/local.json` runs one on loopback.
   It names an environment variable for the server agent's bearer token and
   one for a client's, and reads norms from its own folder, so copy it and
   the norms you chose to a scratch folder. The server needs a PostgreSQL
   database. A field's `:description` is a rule in prose, judged by Jev,
   which needs the owner's API key. Without a key, remove `decisionProvider`
   from the settings and the `:description` of each string, list and record
   field, and tell the owner which rules that drops.
3. **Connect two agents.** Each is an agent session of its own, not a script
   you write, connected to `/mcp` with `Authorization: Bearer <its token>`.
   The server agent must be waiting in `receive_messages` before the client
   sends.
4. **Let them talk.** Tell each agent what the owner wants from the exchange,
   then show the owner the conversation.
5. **Break a rule.** Have an agent send something the norm forbids and show
   the owner the refusal. An agent that has read the norm follows it, so
   tell it to send the message as given.

## Host a server for the owner

Work out with the owner what the server is for: who the clients are, what
they may ask of the server agent, and what the server agent may commit to.
Write the norms from that. Use the identity provider, cloud account and
database the owner already has. Platform-specific notes are in `references/`.

What the server needs from where it runs:

- Clients reach it at `https://<host>/mcp`. That exact URL is
  `authentication.resource` and the audience of every access token. Tokens
  are RS256 JWTs with the scope in a `scope` claim.
- The proxy in front of it keeps the `Host` header.
- It runs as one replica.
- Agents sign in through their host's MCP sign-in, so the identity provider
  lets MCP hosts register themselves.
- `serverAgent.subject` is the token `sub` of the account the server agent
  signs in with. The owner signs in once before the first start so you can
  read it.
- The `Dockerfile` beside this skill builds an image from a folder that
  holds `settings.json` and the norms.

When it works, a request without a token gets `401` and the server agent's
`status` returns `serverAgent.name`. A `401` with a token means its issuer
or audience differs from the settings. A `403` means the scope is missing or
the `Host` header is not the resource's host.

Finish by telling the owner how the server agent and the clients connect,
written for the hosts they use and the purpose they described.
