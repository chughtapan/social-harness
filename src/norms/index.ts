/**
 * @file The norms a server holds, and everything the rest of the daemon uses
 * of the norm language: a norms directory loads as the held norms of its
 * documents. Nothing in this folder imports from outside it.
 */

import { FileSystem } from "@effect/platform";
import { Data, Effect, Either, Order, Schema } from "effect";
import { join } from "node:path";
import { compileNorm } from "./compiler.js";
import { ACT_SYNTAX, readAct } from "./lisp.js";
import { describedFields } from "./norm.js";
import {
  type Judgement,
  type Sent,
  type Stored,
  structureCheck,
} from "./structure-check.js";

/** Which of a conversation's two members sends an act. */
export type { Role } from "./norm.js";
/** A text rule a held norm gives an act, for a decision provider to judge. */
export type { TextRule } from "./structure-check.js";

/** A norms directory the server cannot use, and why. */
export class NormsConfigurationError extends Data.TaggedError(
  "NormsConfigurationError",
)<{ readonly reason: string }> {
  override get message(): string {
    return `The configured norms directory is invalid: ${this.reason}`;
  }
}

/** One norm as a server publishes it: its name, its description and its whole document. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The norms layer owns this grammar, which the read_norms tool returns.
export const publishedNorm = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  document: Schema.String,
});

/**
 * The norms a server holds. `check` is their structure check: it judges one
 * message after the earlier messages of its conversation. `documents` are
 * the norms as the server publishes them, and `actSyntax` says how an act of
 * them is written, for an agent that has to write one. `hasTextRules` says
 * whether any norm describes a string or list field, which gives it a text
 * rule that needs a decision provider.
 */
export interface HeldNorms {
  readonly check: (sent: Sent, earlier: readonly Stored[]) => Judgement;
  readonly documents: ReadonlyArray<typeof publishedNorm.Type>;
  readonly actSyntax: string;
  readonly hasTextRules: boolean;
}

/**
 * Compiles every `.lisp` norm document directly in `directory`, in name
 * order, and holds the norms they declare.
 */
export const loadNorms = Effect.fn("loadNorms")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const documents = yield* fs.readDirectory(directory).pipe(
    Effect.flatMap((files) =>
      Effect.forEach(
        files.filter((file) => file.endsWith(".lisp")).sort(Order.string),
        (file) => fs.readFileString(join(directory, file)),
        { concurrency: 1 },
      ),
    ),
    Effect.catchTag(
      "BadArgument",
      "SystemError",
      ({ message }) => new NormsConfigurationError({ reason: message }),
    ),
  );
  return yield* holdNorms(documents);
});

/** The held norms `documents` declare, or why they are not norms. Norm names are unique. */
export function holdNorms(
  documents: readonly string[],
): Either.Either<HeldNorms, NormsConfigurationError> {
  return Either.all(documents.map(compileNorm)).pipe(
    Either.filterOrLeft(
      (norms) => new Set(norms.map((norm) => norm.name)).size === norms.length,
      () => "two documents name the same norm",
    ),
    Either.mapBoth({
      onLeft: (reason) => new NormsConfigurationError({ reason }),
      onRight: (norms) => ({
        check: structureCheck(norms, readAct),
        actSyntax: ACT_SYNTAX,
        documents: norms.map((norm) => ({
          name: norm.name,
          description: norm.description,
          document: norm.source,
        })),
        hasTextRules: norms.some((norm) =>
          norm.forms.some((form) => describedFields(form).length > 0),
        ),
      }),
    }),
  );
}
