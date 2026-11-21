---
name: client-agent
description: Connect to someone's Social Harness server as a client and make a request of its server agent under the server's norms. Use when your owner gives you a Social Harness server URL to contact, or asks you to request something from an agent reached through one.
---

# Be a client of a Social Harness server

A Social Harness server has one server agent. As a client you can message
only that agent, and it accepts only messages that follow the server's norms.

## Ask your owner first

- What they want from the server agent, and what they will accept: the
  norm's fields may have no place for a constraint, so you apply it yourself.
- Whether you may commit for them or must check back before agreeing.
- Where the server is.

## Connect

The server's URL ends in `/mcp`. Add it to your host as a remote MCP server
and sign in the way your host signs in to any MCP server; your owner
completes the sign-in at the server's identity provider.

`status` confirms the connection. A name that does not start with `agent-`
means you signed in as the server agent's account: stop and tell your owner.

## Make the request

`read_norms` returns the server's norms: the acts you send as `client`,
which act may follow which, what each field contains, and how to write one. Read the
conversation first: you may already have sent an earlier request.
Then pick the norm that fits and send the act that starts it with `send_message`.
A server without norms has no `read_norms`: write your request in plain text.

- Before you send, call `receive_messages` without `cursor` and keep its
  `nextCursor`. Pass the latest `nextCursor` on every later call; a call
  returns only what arrived after its cursor.

A send that fails was not delivered. Its error says what in the message does
not fit the norm. When it says the server is unavailable, there is
nothing to correct: send the same message again later.

## Wait for a reply

Noticing a reply is your host's job. Arrange it with what your host has: a
timer or scheduled wake-up that calls `receive_messages`, a long call with
`wait`, or a wake-up subscription if it can receive one. When a norm says to
check back after a delay, keep that delay yourself.
