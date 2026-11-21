/** @file A norm document compiles to the norm it declares, one that declares something its grammar lacks compiles to nothing, and a norms directory loads as the norms of its documents. */

import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { scopedLive as it } from "@effect/vitest";
import { Effect, Either, FastCheck as fc } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it as vitestIt } from "vitest";
import { compileNorm } from "./compiler.js";
import { holdNorms } from "./index.js";

const shipped = fileURLToPath(
  new URL("../../config/norms/examples/", import.meta.url),
);

/** Whether a document compiles to nothing. */
const refused = (document: string) =>
  Either.match(compileNorm(document), {
    onLeft: () => true,
    onRight: () => false,
  });

const fieldTypes = {
  string: ":type string :min-length 1",
  integer: ":type integer :maximum 9",
  list: ":type list :max-items 2",
} as const;

/** The fields of an act's form: distinct names, each with a type and whether it is optional. */
const fields = fc.uniqueArray(
  fc.record({
    name: fc
      .stringMatching(/^[a-z][a-z0-9-]{0,7}$/u)
      .filter((name) => name !== "norm"),
    type: fc.constantFrom<keyof typeof fieldTypes>("string", "integer", "list"),
    optional: fc.boolean(),
  }),
  { selector: (field) => field.name, maxLength: 4 },
);

type Fields =
  typeof fields extends fc.Arbitrary<infer Generated> ? Generated : never;

/** Text spliced into the declaration each key names. */
type Splices = Partial<Record<"norm" | "open" | "field" | "close", string>>;

/**
 * A document of one norm: `open` starts an instance with the given fields and
 * `close` ends it. Each of `extra` is spliced into the declaration it names.
 */
function document(declared: Fields, extra: Splices = {}) {
  const lines = declared.map(
    ({ name, type, optional }) =>
      `  (field ${name} ${fieldTypes[type]}${optional ? " :optional true" : ""}${extra.field ?? ""})`,
  );
  return [
    `(norm sample${extra.norm ?? ""})`,
    `(act open :by client :starts true :initiates begun${extra.open ?? ""}`,
    ...lines,
    ")",
    `(act close :by (client server) :when begun :ends true${extra.close ?? ""})`,
  ].join("\n");
}

it("compiles every shipped norm document to the norm its file is named for", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = (yield* fs.readDirectory(shipped)).filter((file) =>
      file.endsWith(".lisp"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = yield* fs.readFileString(join(shipped, file));
      expect(compileNorm(source)).toMatchObject(
        Either.right({ name: file.replace(/\.lisp$/u, ""), source }),
      );
    }
  }).pipe(Effect.provide(NodeContext.layer)));

vitestIt(
  "compiles a document to its source, that source's digest, and a form requiring exactly the fields not marked optional",
  () => {
    fc.assert(
      fc.property(fields, (declared) => {
        const source = document(declared);
        const norm = Either.getOrThrow(compileNorm(source));
        const open = norm.forms.find((form) => form.performative === "open");
        expect(norm.source).toBe(source);
        expect(norm.digest).toBe(
          createHash("sha256").update(source, "utf8").digest("hex"),
        );
        expect(
          open?.fields.map(({ name, type, optional }) => ({
            name,
            type,
            optional,
          })),
        ).toEqual(declared);
      }),
    );
  },
);

/** A document whose `open` has one field. */
const sample = document([{ name: "topic", type: "string", optional: false }]);

vitestIt.each<keyof Splices>(["norm", "open", "field", "close"])(
  "refuses a document whose %s declaration has an attribute it does not take",
  (declaration) => {
    expect(
      refused(
        document([{ name: "topic", type: "string", optional: false }], {
          [declaration]: " :unheard x",
        }),
      ),
    ).toBe(true);
  },
);

vitestIt.each([
  ["a sender that is neither role", "(client server)", "(client absent)"],
  ["a fact it clears", ":ends true)", ":ends true :terminates absent)"],
  [
    "a fact it waits on",
    ":ends true)",
    ":ends true :after absent :delay wait :unit seconds)",
  ],
  [
    "an act a relation reads",
    ":ends true)",
    ":ends true (field copy :type string) (relation equals copy (previous absent copy)))",
  ],
  [
    "a field a relation constrains",
    ":ends true)",
    ":ends true (relation equals absent (previous open absent)))",
  ],
  [
    "a field of the act a relation reads",
    ":ends true)",
    ":ends true (field copy :type string) (relation equals copy (previous open absent)))",
  ],
])(
  "refuses a document that names %s it does not declare",
  (...[, declared, undeclared]) => {
    expect(sample).toContain(declared);
    expect(refused(sample.replace(declared, undeclared))).toBe(true);
  },
);

vitestIt.each(["member", "subset"])(
  "refuses a %s relation that holds a string to a string",
  (operator) => {
    expect(
      refused(
        sample.replace(
          ":ends true)",
          `:ends true (field copy :type string) (relation ${operator} copy (previous open topic)))`,
        ),
      ),
    ).toBe(true);
  },
);

vitestIt(
  "reads quoted text with escapes, parentheses and semicolons as one string, and skips comments",
  () => {
    const norm = Either.getOrThrow(
      compileNorm(
        [
          "; a comment before the header",
          '(norm quoted :description "a \\"b\\" (c); d\\n")',
          "(act ask :by client :starts true :ends true ; a trailing comment",
          '  (field words :type string :description "Say (please); then \\\\ ask."))',
        ].join("\n"),
      ),
    );

    expect(norm.description).toBe('a "b" (c); d\n');
    expect(norm.forms).toMatchObject([
      { fields: [{ description: "Say (please); then \\ ask." }] },
    ]);
  },
);

/** A document of the norm `name`, whose one act opens and ends an instance. */
const documentOf = (name: string) =>
  `(norm ${name})
(act ask :by client :starts true :ends true)
`;

vitestIt(
  "holds the norms of several documents, and publishes each with its name, its description and its whole document",
  () => {
    const held = Either.getOrThrow(
      holdNorms([documentOf("second"), documentOf("first")]),
    );

    expect(held.published).toEqual(
      ["second", "first"].map((name) => ({
        name,
        description: "",
        document: documentOf(name),
      })),
    );
    expect(held.hasTextRules).toBe(false);
  },
);

vitestIt.each([
  ["two of one norm", [documentOf("ask"), documentOf("ask")]],
  [
    "one that names a sender that is neither role",
    [documentOf("ask").replace(":by client", ":by absent")],
  ],
  ["one that is not closed", [`${documentOf("ask")}(`]],
])("holds no norms when the documents include %s", (...[, documents]) => {
  expect(
    Either.match(holdNorms(documents), {
      onLeft: () => "none",
      onRight: () => "held",
    }),
  ).toBe("none");
});
