/**
 * @file The norm language as the rest of the daemon uses it: norm documents
 * compile to the norms a server publishes and its firewall enforces. Nothing
 * in this folder imports from outside it.
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

/** One norm as a server publishes it: its name, its description and its whole document. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The read_norms tool returns this shape as it stands, and needs its schema to publish it.
export const publishedNorm = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  document: Schema.String,
});

/**
 * A server's norms, compiled. `structureCheck` checks one message at the
 * time `now`, in milliseconds, after the earlier messages of its
 * conversation. `published` are the norms as every member reads them.
 * `hasTextRules` says whether any norm describes a string or list field,
 * which gives it a text rule that needs a decision provider.
 */
export interface Norms {
  readonly structureCheck: (
    sent: Sent,
    earlier: readonly Sent[],
    now: number,
  ) => Finding;
  readonly published: ReadonlyArray<typeof publishedNorm.Type>;
  readonly hasTextRules: boolean;
}

/**
 * The norms `documents` state, or why they state none: one of them does not
 * compile, or two of them name the same norm.
 */
export function compileNorms(
  documents: readonly string[],
): Either.Either<Norms, string> {
  return Either.all(documents.map(compileNorm)).pipe(
    Either.filterOrLeft(
      (norms) => new Set(norms.map((norm) => norm.name)).size === norms.length,
      () => "two documents name the same norm",
    ),
    Either.map((norms) => ({
      structureCheck: structureCheck(norms, readAct),
      published: norms.map((norm) => ({
        name: norm.name,
        description: norm.description,
        document: norm.document,
      })),
      hasTextRules: norms.some((norm) =>
        norm.forms.some((form) => judgedFields(form).length > 0),
      ),
    })),
  );
}
