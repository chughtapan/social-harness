# Social Harness — agent instructions

Repository skills live in `.agents/skills/`: `checklist` holds the project's
design rules, `software-architecture` its engineering practices, and `docs`
its writing guide.

State only what a check cannot. If `pnpm lint` fails on it, name the check
rather than repeating the rule — prose that duplicates a linter costs context
every turn and drifts from the behavior that is actually enforced.

## Project

Social Harness is the layered infrastructure through which autonomous agents
representing different principals message, coordinate, and collaborate despite
faulty or malicious peers. Agents communicate under structured norms: a
server publishes its norms, and the daemon enforces that both the client and
the server agent follow them on every send. The norms engine under
`src/norms/` is the core of the code. One daemon, `sharnessd`, hosts every
owner's agent and delivers their messages. npm packages use the `@social-harness` scope.
Executables use `sharness*`, environment variables use `SHARNESS_*`, and
protocol namespaces use `org.social-harness/*`.

The daemon image is built from the root
`Dockerfile`; private product overlays stay in deployment. Image publication follows
[Publication and versions](docs/reference/spec/releases.md#publication-and-versions).

`main` is the only track; npm publication membership and versioning follow
[Publication and versions](docs/reference/spec/releases.md#publication-and-versions).
Releases follow the same section: a merge releases after CI passes. Release
notes are built from pull request titles, so a title says what changed for a
user.

**The constitution is `docs/reference/constitution.md` → The constitution.** It is canonical
there and paraphrased nowhere, this file included: two copies at the top of the
same authority order drift, and the drift is invisible.

## The `@social-harness/social-harness` package

The repository root is this package: `src/`, `examples/` and `skills/`. It
implements the agent daemon and its MCP interface for hosts. Read
[what the package installs](docs/reference/spec/package-boundaries.md#what-the-package-installs)
and the contract for the area you change:

- [Host messaging](docs/reference/spec/host/messaging.md) and
  [receiving](docs/reference/spec/host/receiving.md).
- [Daemon lifecycle and MCP interface](docs/reference/spec/daemon.md).
- [Identity](docs/reference/spec/identity/identity-and-attribution.md) and
  [modes](docs/reference/spec/modes.md).
- [Norm language](docs/reference/spec/norms/norms.md) and the
  [firewall](docs/reference/spec/firewall.md) that enforces norms.

`src/norms/` is laid out as a compiler. `lisp.ts` is the frontend and the
only module that knows the syntax. `norm.ts` is the norm it reads documents
into, as plain data. `compiler.ts` checks that norm to be well formed, and
`structure-check.ts` runs it over a conversation. Neither reads syntax: a
change to how norms are written touches `lisp.ts` and the specification's
grammar, and nothing else. The folder imports nothing from the rest of
`src/`: the firewall, the MCP tools and `main.ts` import it through
`norms/index.ts`, which owns every shape of the norm language they use.

Onboarding is agent-led and lives only in `skills/`: an agent reads a skill
and does the setup. `host-a-server` sets up an owner's server (sign-in,
a hosted daemon, norms and rules), `server-agent` makes an agent the one that
answers requests there, and `client-agent` connects an agent to someone's
server. The repository holds no setup scripts, host plugins or how-to guides;
when a setup step is hard, change the daemon so the step disappears, or state
it in the skill. A skill says what must be true, the facts only the daemon's contract can
supply, and what to ask the owner; it does not script the steps or assume a
provider. Keep the skills independent of any one agent host: each host
decides how it signs in, schedules itself and reads its inbox. When code
changes a tool, setting or variable a skill names, change the skill in the
same pull request. Review changes to `examples/` as policy changes: their
text determines what the structure check and the decision provider enforce.

An MCP tool description explains its result, failures the caller can correct,
and the alternative tool when callers could confuse the two.

## Toolchain and skills

Use Node from `.node-version` and the pnpm version in `package.json`. Run build,
test, lint, and typecheck through `pnpm nx` or the package scripts that wrap it.
Effect and `@effect/*` are the runtime idiom. Tooling is TypeScript;
`tsconfig.check.json` enforces erasable syntax for the scripts Node runs
directly. Write `.mjs` or `.js` only for a file a tool cannot load as
TypeScript.

Load the Google guide that matches the work: `google-typescript-style` for
`.ts`, `google-javascript-style` for JavaScript a tool requires,
`google-shell-style` for `.sh`, `google-swe-testing`, `google-documentation-guide`,
`google-swe-change-management`, `google-swe-builds-dependencies-and-ci` for
build, dependency, and CI policy, `google-swe-engineering-standards` for the
lint and architecture gates themselves, and the applicable Google code-review
author or reviewer guide. New code meets its guide in the commit that
introduces it; existing code is brought along by the change that touches it.
Repository law, Effect conventions, Nx, ESLint and oxfmt take precedence. Link
to the guide rather than copying it into the repository, and keep tests and
documentation in the change they explain.

State which checks and reviews actually ran.

## Dependency versions

Each dependency version or digest is set in one source for its kind. A copy
exists only where a tool needs a literal value, such as a lockfile, a
Dockerfile `FROM`, or the manifest of something built outside the workspace.

| Kind | Source |
| --- | --- |
| npm dependency range | `catalog` in `pnpm-workspace.yaml` |
| Forced npm resolution | `overrides` in `pnpm-workspace.yaml` |
| Supported Node.js range | `engines.node` in the root `package.json` |
| Node.js for development and CI | `.node-version` |
| pnpm | `packageManager` in the root `package.json` |
| GitHub Action | its one `uses:` ref; pnpm and Node setup live in `.github/actions/setup-toolchain` |

## Code

- Name a type, a field, a function or a tool argument with the word
  [the vocabulary](docs/reference/spec/vocabulary.md) gives its subject. A new
  concept gets its word there first.
- Symbol questions (where is X defined, who calls it, what type is
  this) → LSP. Grep/Explore only for breadth or text search.
- Cite by symbol name (`file.ts → handleFrame`), never by line;
  `file.ts:NNN` only in PRs, reviews, and issues.
- Rationale goes in JSDoc on the symbol it explains, in the commit
  message, or in a docs file — never scattered inline through a body. A
  `//` line inside a body moves to that symbol's JSDoc or goes; if it
  will not fit there, the function is doing too much. A line directly
  above a named thing sits on that symbol, not in the body: an
  object-literal property, a `const`, an `it`. Lint-disable
  justifications are the exception.
  A shell script's header block is its JSDoc. Write for a cold reader
  in present tense: why the code is shaped this way, non-obvious
  invariants, surprising constants. If deleting a comment loses nothing
  the name and signature already give, delete it, including any doc line
  that repeats the symbol it sits on. `@param` and `@returns` go as a
  whole set or not at all, since a partial set fails
  `jsdoc/check-param-names`; fold what a parameter carries beyond its type
  into the description prose. Lint requires a block on every export, so
  rewrite an export block to say what the name cannot rather than
  deleting it.
  Never issue/spec/phase numbers, change narration
  (formerly, no longer, renamed from), or design alternatives. Rewrite
  touched comments in the same PR; history lives in git, not code.
- A user-facing error with a known fix says what to do. Error messages and
  CLI `--help` text carry no documentation links.

Effect idiom, typed errors, exhaustive switches, and cast bans are enforced by
the `agent-code-guard` eslint rules. Read their output rather than a summary
of it here.

The root `safer-architecture.config.json` is hand-maintained. `pnpm arch:check`
runs safer-architecture-lsp against it.

## Verify

`pnpm lint` needs a prior `pnpm build` — typed linting resolves against built
`.d.ts` outputs, and CI builds first.

## Docs

Read this file and `docs/reference/constitution.md`, then the applicable public specification
under `docs/reference/spec/`. Reconcile a boundary change with its public
specification; do not leave a binding interface specification only in chat,
agent state, or records outside this repository.

Writing or regenerating public docs uses the `docs` skill at
`.agents/skills/docs/SKILL.md`; `.claude/skills/docs` links to the same source.
Keep repository-owned skills under `.agents/skills/` with a matching Claude
link.

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## General Guidelines for working with Nx

- For navigating/exploring the workspace, use the `nx-workspace` skill when available - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), use the `nx-generate` skill when available; otherwise inspect the generator help before running it

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax


<!-- nx configuration end-->
