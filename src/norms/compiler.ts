/**
 * @file Compiles norm documents into norms: reads a document's declarations,
 * builds the norm they state and checks that its turn rules refer to
 * declared acts, fields and facts.
 */

import { Either } from "effect";
import { createHash } from "node:crypto";
import type { Role } from "../messages.js";
import {
  decodeNorm,
  isName,
  type MessageForm,
  type Norm,
  readSExpressions,
  type SExpression,
} from "./norm.js";

/** A compiled value, or why the document is not a norm, in words that do not echo the document's text. */
type Compiled<Value> = Either.Either<Value, string>;

/** A declaration separates named attributes from its child forms and text. */
interface Declaration {
  readonly kind: string;
  readonly name?: string;
  readonly attributes: ReadonlyMap<string, SExpression>;
  readonly children: readonly SExpression[];
}

/** The attributes a field of each type takes besides those every field takes. */
const attributes: Readonly<Record<string, readonly string[]>> = {
  string: [":min-length", ":max-length"],
  integer: [":minimum", ":maximum"],
  list: [":min-items", ":max-items"],
};

/** The norm `source` declares. Its digest names the exact document bytes both members read. */
export function compileNorm(source: string): Compiled<Norm> {
  return Either.gen(function* () {
    const { header, body } = yield* readDocument(source);
    yield* checkAttributes(header, [":description"]);
    if (
      header.name === undefined ||
      !isName(header.name) ||
      header.children.length !== 0
    ) {
      return yield* Either.left(
        "A norm has a lowercase name and no child declarations.",
      );
    }
    const norm = yield* decodeNorm({
      name: header.name,
      digest: createHash("sha256").update(source, "utf8").digest("hex"),
      source,
      description: atom(header.attributes.get(":description")) ?? "",
      forms: yield* Either.all(body.map(compileForm)),
    }).pipe(
      Either.mapLeft(
        () => "A declaration has an invalid name, value or bound.",
      ),
    );
    yield* validateReferences(norm);
    return norm;
  });
}

function compileForm(form: Declaration) {
  return Either.gen(function* () {
    yield* checkAttributes(form, [
      ":by",
      ":starts",
      ":ends",
      ":when",
      ":initiates",
      ":terminates",
      ":max",
      ":after",
      ":delay",
      ":unit",
    ]);
    const children = yield* Either.all(form.children.map(readDeclaration));
    if (
      children.some(
        (child) => child.kind !== "field" && child.kind !== "relation",
      )
    ) {
      return yield* Either.left(
        "Content declarations contain fields and relations.",
      );
    }
    const fields = yield* Either.all(
      children.filter((child) => child.kind === "field").map(compileField),
    );
    if (new Set(fields.map((field) => field.name)).size !== fields.length) {
      return yield* Either.left("Field names must be unique within a form.");
    }
    const maximum = yield* numberAttribute(form, ":max");
    const delay = yield* compileDelay(form);
    return {
      act: form.name ?? "",
      by: yield* compileSender(form),
      fields,
      starts: yield* booleanAttribute(form, ":starts"),
      ends: yield* booleanAttribute(form, ":ends"),
      when: yield* names(form.attributes.get(":when")),
      initiates: yield* names(form.attributes.get(":initiates")),
      terminates: yield* names(form.attributes.get(":terminates")),
      ...(maximum === undefined ? {} : { maximum }),
      ...(delay === undefined ? {} : { delay }),
      relations: yield* Either.all(
        children
          .filter((child) => child.kind === "relation")
          .map(compileRelation),
      ),
    };
  });
}

/** Who may send an act: `client`, `server`, both, or the recipient of the message that set a fact. */
function compileSender(form: Declaration): Compiled<MessageForm["by"]> {
  const node = form.attributes.get(":by");
  if (
    node?.kind !== "list" ||
    atom(node.values[0]) !== "recipient" ||
    node.values[1]?.kind !== "list"
  ) {
    return Either.flatMap(names(node), (senders) => {
      const roles = senders.flatMap((sender): Role[] =>
        sender === "client" || sender === "server" ? [sender] : [],
      );
      return roles.length === 0 || roles.length !== senders.length
        ? Either.left("An act's :by names client, server or both.")
        : Either.right(roles);
    });
  }
  const reference = node.values[1];
  const fact =
    reference.values.length === 2 && atom(reference.values[0]) === "fact"
      ? atom(reference.values[1])
      : undefined;
  return node.values.length !== 2 || fact === undefined
    ? Either.left("A recipient sender selector names one fact.")
    : Either.right({ recipient: { fact } });
}

function compileRelation(form: Declaration) {
  return Either.gen(function* () {
    yield* checkAttributes(form, []);
    const [field, source, ...rest] = form.children;
    if (field?.kind !== "symbol" || source === undefined || rest.length !== 0) {
      return yield* Either.left(
        "A relation names its operator, candidate field and value source.",
      );
    }
    return {
      operator: form.name,
      field: field.value,
      source: yield* compileSource(source),
    };
  });
}

type Source = MessageForm["relations"][number]["source"];

/** A value source: `(previous act field)`, the field of an earlier act. */
function compileSource(node: SExpression): Compiled<Source> {
  const [head, act, field, ...rest] = node.kind === "list" ? node.values : [];
  const named = atom(field);
  if (
    atom(head) !== "previous" ||
    act === undefined ||
    named === undefined ||
    rest.length !== 0
  ) {
    return Either.left("A value source is (previous act field).");
  }
  return Either.map(compileActReference(act), (reference) => ({
    act: reference,
    field: named,
  }));
}

/** A fact names every act that sets it, so a relation may read the same field from alternative forms. */
function compileActReference(node: SExpression): Compiled<Source["act"]> {
  if (node.kind === "list" && atom(node.values[0]) === "fact") {
    const fact = atom(node.values[1]);
    return node.values.length !== 2 || fact === undefined
      ? Either.left("A fact source names one declared fact.")
      : Either.right({ fact });
  }
  const act = atom(node);
  return act === undefined
    ? Either.left("An act reference names one act or one fact.")
    : Either.right(act);
}

function compileDelay(form: Declaration) {
  const fact = atom(form.attributes.get(":after"));
  const field = atom(form.attributes.get(":delay"));
  const unit = atom(form.attributes.get(":unit"));
  if (fact === undefined && field === undefined && unit === undefined) {
    return Either.right(undefined);
  }
  return fact === undefined || field === undefined || unit !== "seconds"
    ? Either.left("A delay supplies :after, :delay and :unit seconds.")
    : Either.right({ fact, field });
}

function compileField(form: Declaration) {
  return Either.gen(function* () {
    const type = atom(form.attributes.get(":type")) ?? "";
    const allowed = Object.hasOwn(attributes, type)
      ? attributes[type]
      : undefined;
    if (
      allowed === undefined ||
      form.name === undefined ||
      !isName(form.name)
    ) {
      return yield* Either.left(
        "A field needs a lowercase name and a supported primitive type.",
      );
    }
    yield* checkAttributes(form, [
      ":type",
      ":optional",
      ":description",
      ...allowed,
    ]);
    if (form.children.length !== 0 || form.name === "ontology") {
      return yield* Either.left(
        "A field cannot redefine envelope metadata or contain child declarations.",
      );
    }
    const description = atom(form.attributes.get(":description"));
    return {
      name: form.name,
      optional: yield* booleanAttribute(form, ":optional"),
      type,
      ...(yield* readBounds(form)),
      ...(description === undefined ? {} : { description }),
    };
  });
}

function readBounds(form: Declaration) {
  return Either.gen(function* () {
    const bounds: Record<string, number> = {};
    for (const [attribute, key] of [
      [":min-length", "minLength"],
      [":max-length", "maxLength"],
      [":minimum", "minimum"],
      [":maximum", "maximum"],
      [":min-items", "minItems"],
      [":max-items", "maxItems"],
    ] as const) {
      const value = yield* numberAttribute(form, attribute);
      if (value !== undefined) {
        bounds[key] = value;
      }
    }
    for (const [minimum, maximum] of [
      ["minLength", "maxLength"],
      ["minItems", "maxItems"],
      ["minimum", "maximum"],
    ] as const) {
      const low = bounds[minimum];
      const high = bounds[maximum];
      const ordered = low === undefined || high === undefined || low <= high;
      const integral =
        minimum === "minimum" ||
        [low, high].every(
          (value) =>
            value === undefined || (Number.isInteger(value) && value >= 0),
        );
      if (!ordered || !integral) {
        return yield* Either.left(
          "Field bounds must be ordered; length and item bounds are nonnegative integers.",
        );
      }
    }
    return bounds;
  });
}

/** All declarations are data; a document has one leading norm header. */
function readDocument(source: string) {
  return Either.gen(function* () {
    const parsed = yield* readSExpressions(source).pipe(
      Either.mapLeft((error) => `${error.detail} Offset ${error.offset}.`),
    );
    const [header, ...body] = yield* Either.all(parsed.map(readDeclaration));
    if (
      header?.kind !== "norm" ||
      body.some((item) => item.kind !== "content")
    ) {
      return yield* Either.left(
        "A document starts with one norm declaration followed by content declarations.",
      );
    }
    return { header, body };
  });
}

/** Attribute names are checked by the declaration that consumes them. */
function readDeclaration(node: SExpression): Compiled<Declaration> {
  if (node.kind !== "list") {
    return Either.left("Expected a parenthesized declaration.");
  }
  const [head, ...tail] = node.values;
  if (head?.kind !== "symbol") {
    return Either.left("A declaration starts with a symbol.");
  }
  const named = ["norm", "content", "field", "relation"].includes(head.value);
  const first = tail[0];
  if (named && (first?.kind !== "symbol" || first.value.startsWith(":"))) {
    return Either.left("The declaration needs a name.");
  }
  return Either.map(
    declarationFields(named ? tail.slice(1) : tail),
    (fields): Declaration => ({
      kind: head.value,
      ...(named && first?.kind === "symbol" ? { name: first.value } : {}),
      ...fields,
    }),
  );
}

/** A declaration's items after its name: each `:attribute` with the value that follows it, and the rest as children. */
function declarationFields(
  items: readonly SExpression[],
): Compiled<Pick<Declaration, "attributes" | "children">> {
  const attributes = new Map<string, SExpression>();
  const children: SExpression[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind === "symbol" && item.value.startsWith(":")) {
      const value = items[index + 1];
      if (
        value === undefined ||
        attributes.has(item.value) ||
        (value.kind === "symbol" && value.value.startsWith(":"))
      ) {
        return Either.left(
          "Each attribute needs one value and must appear once.",
        );
      }
      attributes.set(item.value, value);
      index += 1;
    } else if (item !== undefined) {
      children.push(item);
    }
  }
  return Either.right({ attributes, children });
}

/** Reject typos where their declaration owns the accepted vocabulary. */
function checkAttributes(
  form: Declaration,
  allowed: readonly string[],
): Either.Either<void, string> {
  const unknown = [...form.attributes.keys()].find(
    (key) => !allowed.includes(key),
  );
  return unknown === undefined
    ? Either.void
    : Either.left(`Unknown attribute ${unknown}.`);
}

/** A scalar or list supplies names without comma or whitespace guessing. */
function names(node?: SExpression): Compiled<readonly string[]> {
  if (node === undefined) {
    return Either.right([]);
  }
  const values = (node.kind === "list" ? node.values : [node]).flatMap(
    (value) => atom(value) ?? [],
  );
  return node.kind === "list" && values.length !== node.values.length
    ? Either.left("Expected a name or a list of names.")
    : Either.right(values);
}

/** Missing booleans default to false; other values are rejected. */
function booleanAttribute(form: Declaration, key: string): Compiled<boolean> {
  const node = form.attributes.get(key);
  const value = atom(node);
  if (node === undefined || value === "false") {
    return Either.right(false);
  }
  return value === "true"
    ? Either.right(true)
    : Either.left(`${key} takes true or false.`);
}

/** Numeric constraints cannot carry nonfinite values. */
function numberAttribute(form: Declaration, key: string) {
  const node = form.attributes.get(key);
  if (node === undefined) {
    return Either.right<number | undefined>(undefined);
  }
  const text = atom(node);
  const value =
    text === undefined || text.trim() === "" ? Number.NaN : Number(text);
  return Number.isFinite(value)
    ? Either.right(value)
    : Either.left(`${key} takes a finite number.`);
}

/** Symbols and strings both name configuration values; quoted prose stays unchanged. */
function atom(node?: SExpression): string | undefined {
  return node?.kind === "symbol" || node?.kind === "string"
    ? node.value
    : undefined;
}

/** Invalid references fail installation instead of becoming unreachable runtime forms. */
function validateReferences(norm: Norm): Either.Either<void, string> {
  const forms = new Map(norm.forms.map((form) => [form.act, form]));
  if (forms.size !== norm.forms.length) {
    return Either.left("An act has exactly one declared form.");
  }
  if (!norm.forms.some((form) => form.starts)) {
    return Either.left("Declare at least one opening act with :starts true.");
  }
  return Either.all(
    norm.forms.map((form) => validateForm(norm, form, forms)),
  ).pipe(Either.map(() => undefined));
}

function validateForm(
  norm: Norm,
  form: MessageForm,
  forms: ReadonlyMap<string, MessageForm>,
): Either.Either<void, string> {
  const facts = new Set(norm.forms.flatMap((item) => item.initiates));
  if ("recipient" in form.by && !facts.has(form.by.recipient.fact)) {
    return Either.left("A recipient sender selector names an undeclared fact.");
  }
  if ([...form.when, ...form.terminates].some((fact) => !facts.has(fact))) {
    return Either.left("Fact guards refer to declared facts.");
  }
  if (form.starts && !opens(form)) {
    return Either.left(
      "An opening act names its senders by role and cannot depend on an earlier act.",
    );
  }
  if (form.delay !== undefined && !anchored(norm, form.delay)) {
    return Either.left(
      "A delay references a required nonnegative numeric field on every act that initiates its fact.",
    );
  }
  return Either.all(
    form.relations.map((relation) => validateRelation(form, relation, forms)),
  ).pipe(Either.map(() => undefined));
}

/** Whether a form that starts an instance needs nothing earlier: no fact, delay or relation, and senders named by role. */
function opens(form: MessageForm) {
  return (
    !("recipient" in form.by) &&
    form.when.length === 0 &&
    form.delay === undefined &&
    form.relations.length === 0
  );
}

/** Whether every act that initiates a delay's fact requires the delay's field as a nonnegative integer. */
function anchored(norm: Norm, delay: NonNullable<MessageForm["delay"]>) {
  const anchors = norm.forms.filter((item) =>
    item.initiates.includes(delay.fact),
  );
  return (
    anchors.length !== 0 &&
    anchors.every((anchor) => {
      const field = fieldOf(anchor, delay.field);
      return (
        field?.type === "integer" &&
        !field.optional &&
        field.minimum !== undefined &&
        field.minimum >= 0
      );
    })
  );
}

/**
 * Whether a relation's field and its source field are declared, on every act
 * the source may name, with the types its operator relates: `equals` two
 * fields of one type, `member` a string to a list, `subset` two lists.
 */
function validateRelation(
  form: MessageForm,
  { operator, field, source }: MessageForm["relations"][number],
  forms: ReadonlyMap<string, MessageForm>,
): Either.Either<void, string> {
  const candidate = fieldOf(form, field)?.type;
  const sources = referenceNames(source.act, forms).map((act) => {
    const target = forms.get(act);
    return target && fieldOf(target, source.field)?.type;
  });
  if (
    candidate === undefined ||
    sources.length === 0 ||
    sources.includes(undefined)
  ) {
    return Either.left("A relation refers to undeclared acts or fields.");
  }
  const expected = {
    equals: [candidate, candidate],
    member: ["string", "list"],
    subset: ["list", "list"],
  }[operator];
  return candidate === expected[0] &&
    sources.every((type) => type === expected[1])
    ? Either.void
    : Either.left(
        "An equals relation holds a field to one of its type, a member relation a string to a list, and a subset relation a list to a list.",
      );
}

function referenceNames(
  reference: Source["act"],
  forms: ReadonlyMap<string, MessageForm>,
) {
  if (typeof reference === "string") {
    return [reference];
  }
  return [...forms.values()]
    .filter((form) => form.initiates.includes(reference.fact))
    .map((form) => form.act);
}

/** The field `name` of a form. */
function fieldOf(form: MessageForm, name: string) {
  return form.fields.find((field) => field.name === name);
}
