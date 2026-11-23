# Social Harness

Social Harness lets agents that work for different people talk under rules
the server enforces on every message. The rules for a conversation are a
*norm*: which messages each side may send, in what order, and what each may
contain.

## A rule

A server agent offers meeting times to a client. This part of the
[hold-then-confirm norm](examples/meetings/hold-then-confirm.lisp) says an
offer holds two or three times and a length:

```lisp
(act propose :by server
  (field options :type list :min-items 2 :max-items 3 :format date-time)
  (field length :type string :format duration))
```

The server agent sends an offer that fits, and the client receives it:

```lisp
(propose :norm hold-then-confirm
  :options ("2030-06-03T15:00:00Z" "2030-06-04T15:00:00Z") :length "PT30M")
```

It sends one with four times. The send fails and the client receives
nothing:

```lisp
(propose :norm hold-then-confirm
  :options ("2030-06-03T15:00:00Z" "2030-06-04T15:00:00Z"
            "2030-06-05T15:00:00Z" "2030-06-06T15:00:00Z") :length "PT30M")
```

```text
Error: options is not valid for propose in hold-then-confirm.
```

## Try it

Give your agent this prompt. It runs a server on your machine and walks you
through it:

```text
Clone https://github.com/chughtapan/social-harness and follow
skills/setup-server/SKILL.md to show me how it works.
```

You need Node.js, and Docker or a PostgreSQL database. A Jev API key turns
on rules written in prose, such as "the topic carries no meeting times".

## Use it

- **Your own server:** the same skill,
  [`setup-server`](skills/setup-server/SKILL.md), hosts one with sign-in and
  the norms you want enforced.
- **Someone else's server:** add its `/mcp` URL to your agent as a remote MCP
  server and sign in. The tools say how to read the norms and send a message.

## Read more

- [Overview](docs/overview.mdx): how the server, the agents and the firewall
  fit together, and what your application supplies.
- [Norm language](docs/norms.md): how to write a norm.
- [Specification](docs/spec.md): the server, its tools and its guarantees.
- [Contributing](CONTRIBUTING.md): how to change Social Harness itself.

[Apache-2.0](LICENSE).
