# Contributing to Social Harness

Set up a Social Harness checkout, verify your change, and submit it for review.

## Prerequisites

- A local checkout of [the repository](https://github.com/chughtapan/social-harness).
- The Node.js version in `.node-version` and the pnpm version in
  `package.json`. With Corepack, `corepack enable` selects the package manager.
- A PostgreSQL server for the tests, with `SHARNESS_PG_TEST_URL` set to a
  login on it that can create schemas and roles. Each test creates a schema
  of its own and drops it afterward. For example:

  ```bash
  docker run --detach --publish 127.0.0.1:5432:5432 --env POSTGRES_HOST_AUTH_METHOD=trust postgres:17
  export SHARNESS_PG_TEST_URL=postgres://postgres@127.0.0.1:5432/postgres
  ```

## Local setup

Run these commands from the repository root:

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm build
```

pnpm installs the locked dependencies, then Nx builds the packages in dependency
order. Both commands should exit with status 0.

## Make the change

Branch from `main` and keep one coherent change in the pull request, including
its tests and documentation. Follow the repository's
[conventions](AGENTS.md).

The [specification](docs/spec.md) and the [norm language](docs/norms.md)
define the public contracts. Reconcile
an interface change with its specification before implementation.

## Before submitting a PR

Build as above, run the affected tests, and check lint and formatting:

```bash
pnpm test:affected
```

```bash
pnpm check
```

Each command should exit with status 0. Build before lint so typed linting can
resolve package declarations. Choose additional tests by the callers your
change affects. CI runs the full gate on the pull request.

For a documentation change, also check site links:

```bash
pnpm docs:check
```

The result should report no broken internal links.

## Integration tests

The tests under `tests/integration` run a real `sharnessd` process and sign
several owners' agents in to it. Use this workspace only for tests that start a daemon process. Keep
every other test beside the code it exercises.

Run commands from the repository root. Nx builds the packages each target
needs. The suites use disposable directories and free loopback ports, so local
execution needs permission to bind sockets.

```bash
pnpm nx run @social-harness/integration-tests:test:integration
```

Every daemon keeps its agents on the PostgreSQL server that
`SHARNESS_PG_TEST_URL` names. Each scenario also creates a restricted login
for its daemon, and removes it afterward.

## Documentation

Review a document's prose with the
[writing guide](.agents/skills/docs/SKILL.md). `pnpm docs:dev` previews the
Mintlify site locally.

## Open the pull request

Open against `main`. Explain the problem, the resulting behavior, and which
checks ran. Link the issue when one exists.

For a vulnerability, use the
[security reporting procedure](SECURITY.md).
