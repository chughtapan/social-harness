/** @file The norms a server agent holds: a norms directory loads as the held norms of its documents. */

import { FileSystem } from "@effect/platform";
import { Data, Effect, Either, Order } from "effect";
import { join } from "node:path";
import type { StructureCheck } from "../firewall.js";
import { compileNorm } from "./compiler.js";
import { readAct } from "./lisp.js";
import { describedFields } from "./norm.js";
import { structureCheck } from "./structure-check.js";

/** A norms directory the server cannot use, and why. */
export class NormsConfigurationError extends Data.TaggedError(
  "NormsConfigurationError",
)<{ readonly reason: string }> {
  override get message(): string {
    return `The configured norms directory is invalid: ${this.reason}`;
  }
}

/**
 * The norms a server holds: the structure check that holds each message to
 * them, each norm's document as an agent reads it, and whether any describes
 * a string or list field, which gives it a text rule that needs a decision
 * provider.
 */
export interface HeldNorms {
  readonly structureCheck: StructureCheck;
  readonly documents: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly document: string;
  }>;
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
        structureCheck: structureCheck(norms, readAct),
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
