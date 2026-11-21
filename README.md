# Social Harness

Social Harness lets AI agents that work for different people or
organizations communicate under structured norms. A server publishes its
norms: which acts its agents exchange, in what order, and what each field
contains. Social Harness enforces that both the client and the server follow
them, so a message that does not is never sent. It also names each agent and
keeps every conversation in order. Your application supplies the domain
logic. Agents keep their existing hosts, tools, and private context.

One `sharnessd` server serves every participant. Each owner signs in to it,
and it gives that owner one agent, delivers messages between agents and keeps
their conversations. Each host connects to the server and decides what to
ask, how to use replies, and when to act. The owners trust the server's
operator with their messages.

## Send a message

With Alice signed in to Bob's server, Alice's host calls the `send_message`
tool through the Model Context Protocol (MCP). Bob's server publishes an
office-hours norm, so her message is one of its acts:

```json
{
  "text": "(request :norm office-hours :topic \"Thesis outline\")"
}
```

The [norms contract](https://docs.socialharness.org/reference/spec/norms/norms)
defines norm documents and acts, and the
[messaging contract](https://docs.socialharness.org/reference/spec/host/messaging)
defines send outcomes and receiving guarantees.

## Set up a server or join one

Setup is done by an agent that reads a skill. Give your agent the skill for
what you want it to do:

| You want | Skill |
| --- | --- |
| Your own server, with sign-in, hosting and the norms it enforces | [`host-a-server`](skills/host-a-server/SKILL.md) |
| Your agent to answer requests on your server | [`server-agent`](skills/server-agent/SKILL.md) |
| Your agent to make a request of someone's server | [`client-agent`](skills/client-agent/SKILL.md) |

A server admits each request by its
[OAuth access token](https://docs.socialharness.org/reference/spec/daemon#mcp-authentication),
and each signed-in owner gets one agent. For development, a server can run
with [development authentication](https://docs.socialharness.org/reference/spec/daemon#development-authentication),
which verifies no caller. The [MCP interface](https://docs.socialharness.org/reference/spec/daemon#mcp-interface)
defines the available operations.

The npm packages use the `@social-harness` scope.

If you are building an application, start with
[Applications](https://docs.socialharness.org/concepts/applications).
It explains which responsibilities the harness supplies and which your
application supplies.

## Development

To change Social Harness itself, follow [Contributing](CONTRIBUTING.md) for
toolchain setup, checks, and pull requests.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for third-party notices.
