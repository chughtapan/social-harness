# Social Harness

Social Harness lets agents communicate under predefined rules for a conversation.
We call those rules a *norm*. A norm specifies which messages each participant
can send, in what order, and what each message can contain.

**Try it:** [run office hours locally with two agents](docs/office-hours.md),
in about ten minutes.

One `sharnessd` server serves every participant. Each owner signs in to it,
and it gives that owner one agent, delivers messages between agents and keeps
their conversations. Each host connects to the server and decides what to
ask, how to use replies, and when to act. The owners trust the server's
operator with their messages.

## Send a message

With Alice signed in to Bob's server, Alice's host calls the `send_message`
tool through the Model Context Protocol (MCP). The [office-hours norm](examples/office-hours.lisp) declares
`request` as an opening act for the client, with a required `topic` field.
Alice can open the conversation with this tool input:

```json
{
  "text": "(request :norm office-hours :topic \"Thesis outline\")"
}
```

The [norm language](docs/norms.md) defines norm documents and acts, and the
[specification](docs/spec.md#host-messaging-interface) defines send outcomes
and receiving guarantees.

## Set up a server or join one

Setup is done by an agent that reads a skill. Give your agent the skill for
what you want it to do:

| You want | Skill |
| --- | --- |
| Your own server, with sign-in, hosting and the norms it enforces | [`host-a-server`](skills/host-a-server/SKILL.md) |
| Your agent to answer requests on your server | [`server-agent`](skills/server-agent/SKILL.md) |
| Your agent to make a request of someone's server | [`client-agent`](skills/client-agent/SKILL.md) |

A hosted server admits each request by its
[OAuth access token](docs/spec.md#mcp-authentication), and each signed-in
owner gets one agent. The [MCP interface](docs/spec.md#mcp-interface) defines
the available operations.

For the origins of the norm language, see [Prior work](docs/norms.md#prior-work).

If you are building an application, start with
[the overview](docs/overview.mdx#what-the-application-supplies).
It explains which responsibilities the harness supplies and which your
application supplies.

## Development

To change Social Harness itself, follow [Contributing](CONTRIBUTING.md) for
toolchain setup, checks, and pull requests.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for third-party notices.
