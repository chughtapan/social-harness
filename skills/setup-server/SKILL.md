---
name: setup-server
description: Sets up a Social Harness server, either the example on the owner's machine or a hosted one with sign-in, PostgreSQL and the owner's norms. Use when an owner asks to try Social Harness, or to set up, deploy, change or debug their Social Harness server.
---

# Set up a Social Harness server

The settings file, the environment variables and what stops a start are in
[the specification](https://github.com/chughtapan/social-harness/blob/main/docs/spec.md#agent-daemon)
and `node dist/main.js --help`. Norms are in
[the norm language](https://github.com/chughtapan/social-harness/blob/main/docs/norms.md)
and `examples/`. This skill adds what those do not say.

## Try it on the owner's machine

`examples/office-hours.local.json` is a settings file for a server on
loopback with two bearer tokens, one for a professor's agent, the server
agent, and one for a student's agent, a client. It reads norms from its own
folder, so run it from a scratch copy beside a copy of
`examples/office-hours.lisp`.

- Each agent is a session of its own, not a script you write, connected to
  `/mcp` with `Authorization: Bearer <its token>`.
- Without a Jev key, remove `decisionProvider` from the settings and the
  `:description` of each string, list and record field from the norm.
- The professor must be waiting in `receive_messages` before the student
  sends: a first call returns only what arrives after it.
- An offer of four slots shows a refusal: `propose` allows three. Tell the
  professor to send all four, or it trims the list itself.

## Host it

Ask the owner:

- What clients may ask of the server agent and what must never be said.
  This becomes the norms.
- Which identity provider, cloud account and database they already have.
  With no preference, Auth0 ([references/auth0.md](references/auth0.md)) and
  Railway work.

What must be true:

- One public URL, `https://<host>/mcp`, is the resource. The provider's API
  and `authentication.resource` both name it exactly.
- TLS ends in front of the server and the `Host` header is kept.
- One replica.
- The provider publishes OAuth or OpenID discovery, lets MCP hosts register
  themselves, and grants a registered host the scope for the person who
  signs in.
- An access token is an RS256 JWT whose `iss` equals `authentication.issuer`
  exactly, with the resource as `aud`, a `sub`, an `exp`, and the scope in a
  space-separated `scope` claim.
- `serverAgent.subject` is the `sub` of the account the server agent's owner
  signs in with. Have the owner sign in at the provider once before the
  first start (Auth0: `auth0 test login`) and read it.
- Clients read every norm whole and are told why a message was refused.
- The server folder holds `settings.json`, `norms/<name>.lisp` and the
  `Dockerfile` beside this skill, which copies the folder into the image and
  sets `SHARNESS_CONFIG_FILE`.

```json
{
  "port": 4319,
  "host": "0.0.0.0",
  "authentication": {
    "resource": "https://<host>/mcp",
    "issuer": "<issuer>",
    "scope": "<scope>"
  },
  "serverAgent": { "name": "<name clients see>", "subject": "<sub>" },
  "normsDirectory": "norms",
  "decisionProvider": { "model": "<Jev model>" }
}
```

Check:

- The log ends with `sharnessd listening on`.
- A request with no token gets `401` and a `resource_metadata` link.
- The signed-in server agent's `status` returns `serverAgent.name`.
- `401` with a token: `iss` or `aud` differs from the settings, or the token
  has expired.
- `403`: the scope is missing, or `Host` or `Origin` is not the resource's
  hostname.

Hand the owner two prompts, filled in. For the server agent:

```text
You are the server agent of the Social Harness server at https://<host>/mcp.
Add it as a remote MCP server and sign in as <account>. status must return
<serverAgent.name>. Keep calling receive_messages and answer each client
under the norms from read_norms.
```

For each client:

```text
Add the Social Harness server at https://<host>/mcp as a remote MCP server
and sign in. Then ask me what I want from <serverAgent.name>.
```
