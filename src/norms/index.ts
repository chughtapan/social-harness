/**
 * @file The norm language as the rest of the daemon uses it. A norm has two
 * forms and no others: the document its author writes and every member
 * reads, and the norm that document compiles to, which the structure check
 * runs. Nothing in this folder imports from outside it.
 */

import { Either, Schema } from "effect";
import { compileNorm } from "./compiler.js";
import { readAct } from "./lisp.js";
import { judgedFields } from "./norm.js";
import { type Finding, type Sent, structureCheck } from "./structure-check.js";

/** How an act is written, for an agent that has to write one. */
export { ACT_SYNTAX } from "./lisp.js";
/** Which of a conversation's two members sends a message. */
export type { Role } from "./norm.js";
/** A text rule a norm gives an act, for a decision provider to judge. */
export type { TextRule } from "./structure-check.js";

/** A norm's document as a member reads it, under the name and the description it states. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The read_norms tool returns this shape as it stands, and needs its schema to publish it.
export const normDocument = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  document: Schema.String,
});

/**
 * A server's norms: at least one. `documents` are what every member reads.
 * `structureCheck` checks one message at the time `now`, in milliseconds,
 * after the earlier messages of its conversation. `hasTextRules` says
 * whether any norm describes a string or list field, which gives it a text
 * rule that needs a decision provider. A server without norms has no value
 * of this type.
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
 * The norms `documents` compile to, or why they are no server's norms: there
 * is no document, one of them does not compile, or two of them name the
 * same norm.
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
