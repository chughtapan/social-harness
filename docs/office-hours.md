---
title: Run office hours locally
description: Connect two live agent sessions to a local daemon and use the published office-hours norm.
read_when:
  - You want to try Social Harness from a checkout
  - You want to change a conversation rule and see its effect
---

Run a professor's agent and a student's agent in two sessions of any host that
can reach a loopback Streamable HTTP MCP endpoint and supply a bearer header.
You need the hosts' ordinary model access, a Jev API key for judging prose,
and a dedicated empty PostgreSQL database. The example below uses Docker for
PostgreSQL. The appointments are fictional.

## Start the daemon

Clone the repository and enter the checkout. Select the Node version in
`.node-version` and the pnpm version in `package.json`.

```sh
git clone --branch next https://github.com/chughtapan/social-harness.git
cd social-harness
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Start a disposable database on loopback. If you already have an empty database,
set `SHARNESS_DATABASE_URL` to its connection URL and skip the Docker commands.

```sh
docker run --detach --rm --name sharness-office-hours-db -p 127.0.0.1:55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=office_hours postgres:17
export SHARNESS_DATABASE_URL=postgres://postgres@127.0.0.1:55432/office_hours
docker exec sharness-office-hours-db pg_isready -U postgres
```

Wait for PostgreSQL to report that it accepts connections. Export your Jev
key as `SHARNESS_DECISION_PROVIDER_KEY` in the daemon shell. Prepare a
private run directory and start the daemon from the repository root.

```sh
umask 077
mkdir -p .tmp/office-hours
cp examples/office-hours.local.json examples/office-hours.lisp .tmp/office-hours/
openssl rand -hex 32 > .tmp/office-hours/professor.token
openssl rand -hex 32 > .tmp/office-hours/student.token
export SHARNESS_PROFESSOR_TOKEN="$(cat .tmp/office-hours/professor.token)"
export SHARNESS_STUDENT_TOKEN="$(cat .tmp/office-hours/student.token)"
export SHARNESS_CONFIG_FILE=.tmp/office-hours/office-hours.local.json
node dist/main.js
```

Wait for `sharnessd listening on http://127.0.0.1:4319/mcp`.

## Connect the two agents

In each host's MCP connection settings, enter that URL and set
`Authorization: Bearer <token>` using the contents of its own role's token file.
Both agents should call `status` and `read_norms`. The professor gets the
name `professor`, the student gets an `agent-…` name, and both see `office-hours`.
A 401 means the host needs the current token for its session. Local tokens
expire one hour after the daemon starts.

Give the professor this prompt first.

> Use the published office-hours norm. I authorize you to offer a fictional
> 30-minute meeting on June 3 or June 4, 2030 at 15:00 UTC. Start reading
> your inbox now and keep its cursor. Wait for the student's request, use a
> five-second hold, and confirm the appointment in this conversation.

Once the professor is listening, give the student this prompt.

> Use the office-hours norm to request a meeting about my thesis outline.
> I can attend June 4, 2030 at 15:00 UTC. You may agree for me. Keep your
> inbox cursor, wait for the requested delay, and continue until confirmation.

Read the result with `read_conversation`. The student supplies no arguments.
The professor supplies `with` set to the student's agent name. On the successful
path, both see these acts in order:

```text
student     request
professor   propose
student     accept-proposal
professor   agree
student     query-if
professor   confirm
```

Hosts keep the `nextCursor` from each inbox read and pass it as `cursor` on
the next. Each reply names its earlier message with `replyToMsgId`.

## Change a rule

In the scratch copy of `office-hours.lisp`, change `:max-items 3` on the
proposal's options to `:max-items 2`. Restart the daemon and have both agents
call `read_norms` to see the edit. Start a fresh request. Ask the professor
to try three distinct valid slots, then two. The first send should return a
tool error. The second should appear in the student's conversation.

Stop the daemon with Ctrl-C. If you started the disposable database, run
`docker stop sharness-office-hours-db` to discard it. Delete the generated
token files once you finish.
