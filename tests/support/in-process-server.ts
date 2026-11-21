/**
 * @file The server in a test's own process: `server.ts` opened on a test
 * database with the server agent's real firewall. A test signs agents in and
 * calls their tools as a host does, through the MCP SDK's handler.
 */

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Effect } from "effect";
import type { DecisionProvider } from "../../src/decision-provider.js";
import type { HeldNorms } from "../../src/norms/index.js";
import { type Firewall, makeFirewall } from "../../src/firewall.js";
import { mcpServerFactory } from "../../src/mcp.js";
import { AgentName } from "../../src/messages.js";
import { openServer } from "../../src/server.js";
import { openTestDatabase } from "./database.js";
import { callTool, type SignedIn } from "./host.js";

/** The issuer of every owner a test signs in by name. */
const issuer = "urn:social-harness:test";

/** The URL the SDK client addresses; no listener answers it. */
const endpoint = new URL("http://127.0.0.1/mcp");

/**
 * A server whose server agent is named `alice` and owned by the owner
 * `alice`, behind a firewall with the given norms, the provider that judges
 * their text rules and the history limit, or one that allows every message.
 * `firewall` replaces that firewall. `signInAs` gives an MCP connection as the agent of an owner:
 * the owner a name stands for, or the owner given.
 */
export const inProcessServer = Effect.fn("inProcessServer")(function* (
  options: {
    readonly norms?: HeldNorms;
    readonly provider?: DecisionProvider;
    readonly historyLimit?: number;
    readonly firewall?: Firewall;
  } = {},
) {
  const database = yield* openTestDatabase();
  const server = yield* openServer(
    database.url,
    AgentName.make("alice"),
    options.firewall ??
      makeFirewall({
        norms: options.norms,
        judge: options.provider && {
          provider: options.provider,
          minimumProbability: 0.8,
          timeoutMilliseconds: 5_000,
          maximumConcurrentChecks: 4,
        },
        historyLimit: options.historyLimit,
      }),
  ).pipe(Effect.orDie);
  const factory = yield* mcpServerFactory(
    server,
    { issuer, subject: "alice" },
    options.norms,
  );
  const handler = createMcpHandler(factory);
  return {
    sql: database.sql,
    signInAs: (
      owner: string | { readonly issuer: string; readonly subject: string },
    ) =>
      Effect.gen(function* () {
        const authInfo = {
          token: "",
          clientId: "",
          scopes: [],
          extra:
            typeof owner === "string"
              ? { issuer, subject: owner }
              : { ...owner },
        };
        const mcp = yield* connect((request) =>
          handler.fetch(request, { authInfo }),
        );
        const { agentName } = yield* callTool({ mcp }, "status").pipe(
          Effect.orDie,
        );
        const signedIn: SignedIn = { name: agentName, mcp };
        return signedIn;
      }),
  };
});

/** An SDK client whose requests `answer` answers. The scope closes it. */
function connect(answer: (request: Request) => ReturnType<typeof fetch>) {
  return Effect.gen(function* () {
    const mcp = new Client(
      { name: "server-test", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: (input, init) => answer(new Request(input, init)),
    });
    yield* Effect.tryPromise(() => mcp.connect(transport)).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => mcp.close()).pipe(Effect.ignore),
    );
    return mcp;
  });
}
