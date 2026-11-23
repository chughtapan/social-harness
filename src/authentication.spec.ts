/** @file Local owners are verified by the SDK with the credentials and expiry fixed at startup. */
import { verifyBearerToken } from "@modelcontextprotocol/server";
import { ConfigProvider, Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { authenticate } from "./authentication.js";

afterEach(() => vi.restoreAllMocks());

const settings = {
  mode: "local",
  tokenEnvBySubject: { server: "SERVER", client: "CLIENT" },
} as const;

const load = (host = "127.0.0.1", client = "second", server = "server") =>
  authenticate(settings, host, 4319, server).pipe(
    Effect.withConfigProvider(
      ConfigProvider.fromMap(
        new Map([
          ["SERVER", "first"],
          ["CLIENT", client],
        ]),
      ),
    ),
  );

it("verifies each owner for one hour from startup", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const original = Date.now();
      const now = vi.spyOn(Date, "now").mockReturnValue(original);
      const { bearerAuth: options } = yield* load();
      const verify = (header: string) =>
        Effect.tryPromise(() => verifyBearerToken(header, options));
      expect((yield* verify("Bearer first")).extra?.subject).toBe("server");
      expect((yield* verify("Bearer second")).extra?.subject).toBe("client");
      expect(
        yield* Effect.isFailure(
          Effect.tryPromise(() => verifyBearerToken(undefined, options)),
        ),
      ).toBe(true);
      expect(yield* Effect.isFailure(verify("Bearer unknown"))).toBe(true);
      now.mockReturnValue(original + 3_601_000);
      expect(yield* Effect.isFailure(verify("Bearer first"))).toBe(true);
    }),
  ));
it("rejects ambiguous credentials, an absent server owner and a public bind", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const [check, message] of [
        [load("0.0.0.0"), "loopback"],
        [load("::1", "first"), "distinct"],
        [load("::1", ""), "CLIENT"],
        [load("::1", "second", "unknown"), "server agent subject"],
      ] as const) {
        expect(yield* Effect.flip(check)).toContain(message);
      }
    }),
  ));
