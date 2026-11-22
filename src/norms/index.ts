/**
 * @file The entry point of the norm language. The rest of the server imports
 * only from this file, and nothing in this folder imports from outside it.
 *
 * A norm exists in two forms: the document its author writes, which every
 * member can read, and the compiled norm, which the structure check runs.
 */

import { Either, Schema } from "effect";
import { compileNorm } from "./compiler.js";
import { readAct } from "./lisp.js";
import { judgedFields } from "./norm.js";
import { type Finding, type Sent, structureCheck } from "./structure-check.js";

/** Instructions for writing an act, addressed to an agent. */
export { ACT_SYNTAX } from "./lisp.js";
/** The member of a conversation that sends a message: `client` or `server`. */
export type { Role } from "./norm.js";
/** A rule about a field's text, which the decision provider judges. */
export type { TextRule } from "./structure-check.js";

/** One norm as `read_norms` returns it: its name, its description and the full document. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The read_norms tool returns this shape as it stands, and needs its schema to publish it.
export const normDocument = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  document: Schema.String,
});

/**
 * A server's compiled norms. There is always at least one.
 *
 * `documents` is what `read_norms` returns. `structureCheck` checks one
 * message against the earlier messages of its conversation, where `now` is
 * the current time in Unix milliseconds. `hasTextRules` is true when any
 * norm gives a string or list field a description, which means the server
 * needs a decision provider.
 */
export interface Norms {
  readonly documents: ReadonlyArray<typeof normDocument.Type>;
  readonly structureCheck: (
    sent: Sent,
    earlier: readonly Sent[],
    now: number,
  ) => Finding;
  readonly hasTextRules: boolean;
}

/**
 * Compiles the documents into a server's norms. Fails if there are no
 * documents, if one does not compile, or if two have the same norm name.
 */
export function compileNorms(
  documents: readonly string[],
): Either.Either<Norms, string> {
  return Either.all(documents.map(compileNorm)).pipe(
    Either.filterOrLeft(
      (norms) => norms.length > 0,
      () => "there is no norm document",
    ),
    Either.filterOrLeft(
      (norms) => new Set(norms.map((norm) => norm.name)).size === norms.length,
      () => "two documents name the same norm",
    ),
    Either.map((norms) => ({
      documents: norms.map((norm) => ({
        name: norm.name,
        description: norm.description,
        document: norm.document,
      })),
      structureCheck: structureCheck(norms, readAct),
      hasTextRules: norms.some((norm) =>
        norm.forms.some((form) => judgedFields(form).length > 0),
      ),
    })),
  );
}
