/**
 * @file The Lisp frontend of the norm language: it reads a norm document as a
 * norm and a message's text as an act. Both are parenthesized data that is
 * never evaluated. The frontend settles syntax only: whether the norm it
 * reads is well formed is the compiler's question, and whether an act may be
 * sent is the structure check's.
 */

import { Either } from "effect";
import { createHash } from "node:crypto";
import {
  type Act,
  type Delay,
  type Field,
  type FieldValue,
  type Form,
  isName,
  type Norm,
  type Relation,
  type Role,
  type Senders,
} from "./norm.js";

/** What the frontend read, or why the text is not that, in words that do not echo the text. */
type Read<A> = Either.Either<A, string>;

/** One value of parenthesized data: a symbol, a quoted string or a list. */
type SExpression =
  | { readonly kind: "symbol"; readonly value: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "list"; readonly values: readonly SExpression[] };

/**
 * One declaration of a document: its keyword, the name that follows it in a
 * `norm`, `act`, `field` or `relation`, its `:attribute value` pairs and the
 * rest of its items.
 */
interface Declaration {
  readonly kind: string;
  readonly name?: string;
  readonly attributes: ReadonlyMap<string, SExpression>;
  readonly children: readonly SExpression[];
}

/** The form of a symbol that is a number: a JSON number. */
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

/**
 * How an act is written, for an agent that has to write one. It reads beside
 * the tool that returns the norm documents.
 */
export const ACT_SYNTAX =
  'A message is one act and nothing else: (<performative> :norm <norm> :<field> <value> ...). Quote text as a JSON string, write a list as quoted strings in parentheses such as ("first" "second"), and send an act without fields as (<performative> :norm <norm>). The act that starts an instance omits replyToMsgId in send_message; every later act supplies the id of the message it answers.';

/** The attributes that bound a field of each type. */
const bounds = {
  string: [":min-length", ":max-length"],
  integer: [":minimum", ":maximum"],
  list: [":min-items", ":max-items"],
} as const;

/** The norm a document states: one `norm` declaration, then an `act` declaration for each form. */
export function readNorm(document: string): Read<Norm> {
  return Either.gen(function* () {
    const expressions = yield* Either.mapLeft(
      readSExpressions(document, true),
      ({ detail, offset }) => `${detail} Offset ${offset}.`,
    );
    const [header, ...body] = yield* Either.all(
      expressions.map(readDeclaration),
    );
    if (header?.kind !== "norm" || body.some(({ kind }) => kind !== "act")) {
      return yield* Either.left(
        "A document starts with one norm declaration followed by act declarations.",
      );
    }
    yield* checkAttributes(header, [":description"]);
    if (header.name === undefined || header.children.length !== 0) {
      return yield* Either.left("A norm has a name and no child declarations.");
    }
    return {
      name: header.name,
      description: (yield* textAttribute(header, ":description")) ?? "",
      forms: yield* Either.all(body.map(readForm)),
      document,
      digest: createHash("sha256").update(document, "utf8").digest("hex"),
    };
  });
}

/**
 * The act a message's text states. The whole text is one list: a
 * performative, then `:field value` pairs, of which `:norm` names the act's
 * norm. A value is a quoted string, a symbol or a list of those. A symbol
 * that has the form of a number is one, and any other symbol is its own
 * text. A message carries no comment.
 */
export function readAct(text: string): Read<Act> {
  return readSExpressions(text, false).pipe(
    Either.mapLeft(({ detail }) => detail),
    Either.flatMap(([form, ...extra]) => {
      if (form?.kind !== "list" || extra.length !== 0) {
        return Either.left("The message is not exactly one parenthesized act.");
      }
      const [head, ...parameters] = form.values;
      return head?.kind !== "symbol" ||
        !isName(head.value) ||
        parameters.length % 2 !== 0
        ? Either.left(
            "An act names a performative followed by :field value pairs.",
          )
        : readParameters(head.value, parameters);
    }),
  );
}

function readParameters(
  performative: string,
  parameters: readonly SExpression[],
): Read<Act> {
  return Either.gen(function* () {
    const fields = new Map<string, FieldValue>();
    for (let index = 0; index < parameters.length; index += 2) {
      const key = parameters[index];
      const value = parameters[index + 1];
      if (
        key?.kind !== "symbol" ||
        !key.value.startsWith(":") ||
        !isName(key.value.slice(1)) ||
        value === undefined
      ) {
        return yield* Either.left(
          "Parameters must have distinct :names and one value each.",
        );
      }
      const field = key.value.slice(1);
      if (fields.has(field)) {
        return yield* Either.left(`${field} appears more than once.`);
      }
      fields.set(field, yield* readValue(value));
    }
    const norm = fields.get("norm");
    if (typeof norm !== "string") {
      return yield* Either.left(":norm must name the act's norm.");
    }
    fields.delete("norm");
    return { performative, norm, fields: Object.fromEntries(fields) };
  });
}

function readValue(node: SExpression): Read<FieldValue> {
  if (node.kind === "string") {
    return Either.right(node.value);
  }
  if (node.kind === "list") {
    const items = node.values.flatMap((item) =>
      item.kind === "list" ? [] : [item.value],
    );
    return items.length === node.values.length
      ? Either.right(items)
      : Either.left("A list contains strings, not lists.");
  }
  if (!NUMBER.test(node.value)) {
    return Either.right(node.value);
  }
  return Number.isFinite(Number(node.value))
    ? Either.right(Number(node.value))
    : Either.left("Numbers must be finite.");
}

/** The form an `act` declaration states: its turn rule in its attributes, and a child for each field and relation. */
function readForm(form: Declaration): Read<Form> {
  return Either.gen(function* () {
    yield* checkAttributes(form, [
      ":by",
      ":starts",
      ":ends",
      ":when",
      ":sets",
      ":clears",
      ":max",
      ":after",
      ":delay",
      ":unit",
    ]);
    const children = yield* Either.all(form.children.map(readDeclaration));
    if (children.some(({ kind }) => kind !== "field" && kind !== "relation")) {
      return yield* Either.left(
        "An act declaration contains fields and relations.",
      );
    }
    return {
      performative: form.name ?? "",
      by: yield* readSenders(form),
      fields: yield* Either.all(
        children.filter(({ kind }) => kind === "field").map(readField),
      ),
      starts: yield* booleanAttribute(form, ":starts"),
      ends: yield* booleanAttribute(form, ":ends"),
      when: yield* names(form.attributes.get(":when")),
      clears: yield* names(form.attributes.get(":clears")),
      sets: yield* names(form.attributes.get(":sets")),
      max: yield* numberAttribute(form, ":max"),
      delay: yield* readDelay(form),
      relations: yield* Either.all(
        children.filter(({ kind }) => kind === "relation").map(readRelation),
      ),
    };
  });
}

/** Who `:by` lets send an act: `client`, `server`, both, or `(recipient (fact name))`. */
function readSenders(form: Declaration): Read<Senders> {
  const node = form.attributes.get(":by");
  if (node?.kind === "list" && symbol(node.values[0]) === "recipient") {
    const fact = node.values.length === 2 ? factOf(node.values[1]) : undefined;
    return fact === undefined
      ? Either.left("A recipient sender selector is (recipient (fact name)).")
      : Either.right({ kind: "recipient", fact });
  }
  return Either.flatMap(names(node), (senders) => {
    const roles = senders.flatMap((sender): Role[] =>
      sender === "client" || sender === "server" ? [sender] : [],
    );
    return roles.length === 0 || roles.length !== senders.length
      ? Either.left("An act's :by names client, server or both.")
      : Either.right({ kind: "roles", roles });
  });
}

/** The wait `:after fact :delay field :unit seconds` states. The three attributes come together. */
function readDelay(form: Declaration): Read<Delay | undefined> {
  const fact = symbol(form.attributes.get(":after"));
  const secondsField = symbol(form.attributes.get(":delay"));
  const unit = symbol(form.attributes.get(":unit"));
  if (fact === undefined && secondsField === undefined && unit === undefined) {
    return Either.right(undefined);
  }
  return fact === undefined || secondsField === undefined || unit !== "seconds"
    ? Either.left("A delay supplies :after, :delay and :unit seconds.")
    : Either.right({ fact, secondsField });
}

function readField(form: Declaration): Read<Field> {
  return Either.gen(function* () {
    const type = symbol(form.attributes.get(":type"));
    if (
      form.name === undefined ||
      (type !== "string" && type !== "integer" && type !== "list")
    ) {
      return yield* Either.left(
        "A field needs a name and the type string, integer or list.",
      );
    }
    const [lower, upper] = bounds[type];
    yield* checkAttributes(form, [
      ":type",
      ":optional",
      ":description",
      lower,
      upper,
    ]);
    if (form.children.length !== 0) {
      return yield* Either.left("A field contains no child declarations.");
    }
    if (form.name === "norm") {
      return yield* Either.left(
        "No field is named norm: an act names its norm with :norm.",
      );
    }
    const described = {
      name: form.name,
      optional: yield* booleanAttribute(form, ":optional"),
      description: yield* textAttribute(form, ":description"),
    };
    const low = yield* numberAttribute(form, lower);
    const high = yield* numberAttribute(form, upper);
    switch (type) {
      case "string":
        return { ...described, type, minLength: low, maxLength: high };
      case "integer":
        return { ...described, type, minimum: low, maximum: high };
      case "list":
        return { ...described, type, minItems: low, maxItems: high };
      default: {
        const exhaustive: never = type;
        return exhaustive;
      }
    }
  });
}

/** The relation `(relation operator field (previous act field))` states. */
function readRelation(form: Declaration): Read<Relation> {
  return Either.gen(function* () {
    yield* checkAttributes(form, []);
    const operator = form.name;
    const [field, source, ...rest] = form.children;
    if (
      operator !== "equals" &&
      operator !== "member" &&
      operator !== "subset"
    ) {
      return yield* Either.left(
        "A relation's operator is equals, member or subset.",
      );
    }
    if (field?.kind !== "symbol" || source === undefined || rest.length !== 0) {
      return yield* Either.left(
        "A relation names its operator, its field and one value source.",
      );
    }
    return {
      operator,
      field: field.value,
      source: yield* readSource(source),
    };
  });
}

/** The value source `(previous act field)` states, whose act is a performative or `(fact name)`. */
function readSource(node: SExpression): Read<Relation["source"]> {
  const [head, act, field, ...rest] = node.kind === "list" ? node.values : [];
  const named = symbol(field);
  if (symbol(head) !== "previous" || named === undefined || rest.length !== 0) {
    return Either.left("A value source is (previous act field).");
  }
  const fact = factOf(act);
  const performative = symbol(act);
  if (fact !== undefined) {
    return Either.right({ act: { kind: "fact", fact }, field: named });
  }
  return performative === undefined
    ? Either.left("An act reference names one act or (fact name).")
    : Either.right({
        act: { kind: "performative", performative },
        field: named,
      });
}

/** The fact `(fact name)` names. */
function factOf(node?: SExpression): string | undefined {
  return node?.kind === "list" &&
    node.values.length === 2 &&
    symbol(node.values[0]) === "fact"
    ? symbol(node.values[1])
    : undefined;
}

/** A list whose first item is a symbol is a declaration. A `norm`, `act`, `field` or `relation` names itself with its next item. */
function readDeclaration(node: SExpression): Read<Declaration> {
  if (node.kind !== "list") {
    return Either.left("Expected a parenthesized declaration.");
  }
  const [head, ...tail] = node.values;
  if (head?.kind !== "symbol") {
    return Either.left("A declaration starts with a symbol.");
  }
  const named = ["norm", "act", "field", "relation"].includes(head.value);
  const first = tail[0];
  if (named && (first?.kind !== "symbol" || first.value.startsWith(":"))) {
    return Either.left("The declaration needs a name.");
  }
  return Either.map(
    declarationItems(named ? tail.slice(1) : tail),
    (items): Declaration => ({
      kind: head.value,
      ...(named && first?.kind === "symbol" ? { name: first.value } : {}),
      ...items,
    }),
  );
}

/** A declaration's items after its name: each `:attribute` with the value that follows it, and the rest as children. */
function declarationItems(
  items: readonly SExpression[],
): Read<Pick<Declaration, "attributes" | "children">> {
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

/** Whether a declaration has only attributes it takes, so that a misspelled one is refused. */
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

/** The names an attribute gives: one symbol, or a list of symbols. Without the attribute there are none. */
function names(node?: SExpression): Read<readonly string[]> {
  if (node === undefined) {
    return Either.right([]);
  }
  const items = node.kind === "list" ? node.values : [node];
  const named = items.flatMap((item) => symbol(item) ?? []);
  return named.length === items.length
    ? Either.right(named)
    : Either.left("Expected a name or a list of names.");
}

/** Whether an attribute says `true`. Without the attribute it is false. */
function booleanAttribute(form: Declaration, key: string): Read<boolean> {
  const node = form.attributes.get(key);
  const value = symbol(node);
  if (node === undefined || value === "false") {
    return Either.right(false);
  }
  return value === "true"
    ? Either.right(true)
    : Either.left(`${key} takes true or false.`);
}

/** The finite number an attribute gives, when the declaration has it. */
function numberAttribute(
  form: Declaration,
  key: string,
): Read<number | undefined> {
  const node = form.attributes.get(key);
  if (node === undefined) {
    return Either.right(undefined);
  }
  const text = symbol(node);
  const value =
    text !== undefined && NUMBER.test(text) ? Number(text) : Number.NaN;
  return Number.isFinite(value)
    ? Either.right(value)
    : Either.left(`${key} takes a finite number.`);
}

/** The quoted string an attribute gives, when the declaration has it. */
function textAttribute(
  form: Declaration,
  key: string,
): Read<string | undefined> {
  const node = form.attributes.get(key);
  return node === undefined || node.kind === "string"
    ? Either.right(node?.value)
    : Either.left(`${key} takes a quoted string.`);
}

/** The text of a symbol. */
function symbol(node?: SExpression): string | undefined {
  return node?.kind === "symbol" ? node.value : undefined;
}

/**
 * Reads every expression of `text`: lists in parentheses, strings quoted
 * with JSON escaping, and symbols, which are every other run of characters.
 * A `;` starts a comment that runs to the end of its line, which a document
 * may carry and a message may not, so that every token of a message is
 * accounted for. A failure gives the offset of the token at fault.
 */
function readSExpressions(
  text: string,
  comments: boolean,
): Either.Either<
  readonly SExpression[],
  { readonly offset: number; readonly detail: string }
> {
  const roots: SExpression[] = [];
  const stack: SExpression[][] = [roots];
  const tokens = /\s+|;[^\r\n]*|[()]|"(?:[^"\\]|\\[\s\S])*"|[^\s();"]+/uy;
  let offset = 0;
  while (offset < text.length) {
    tokens.lastIndex = offset;
    const token = tokens.exec(text)?.[0];
    const refusal =
      token === undefined
        ? "Expected a complete token."
        : acceptToken(token, stack, comments);
    if (refusal !== undefined) {
      return Either.left({ offset, detail: refusal });
    }
    offset = tokens.lastIndex;
  }
  return stack.length === 1
    ? Either.right(roots)
    : Either.left({ offset, detail: "An opening parenthesis is not closed." });
}

/** Adds one token to the innermost open list, and gives why the token cannot stand where it does. */
function acceptToken(
  token: string,
  stack: SExpression[][],
  comments: boolean,
): string | undefined {
  const parent = stack.at(-1);
  if (parent === undefined || /^\s/u.test(token)) {
    return undefined;
  }
  if (token.startsWith(";")) {
    return comments
      ? undefined
      : "A message cannot carry a comment outside its declared fields.";
  }
  if (token === "(") {
    const values: SExpression[] = [];
    parent.push({ kind: "list", values });
    stack.push(values);
    return undefined;
  }
  if (token === ")") {
    if (stack.length === 1) {
      return "Unexpected closing parenthesis.";
    }
    stack.pop();
    return undefined;
  }
  if (!token.startsWith('"')) {
    parent.push({ kind: "symbol", value: token });
    return undefined;
  }
  const value = Either.getOrUndefined(
    Either.try((): unknown => JSON.parse(token)),
  );
  if (typeof value !== "string") {
    return "Use JSON escaping inside quoted strings.";
  }
  if (/\p{Surrogate}/u.test(value)) {
    return "Expected a well-formed Unicode string.";
  }
  parent.push({ kind: "string", value });
  return undefined;
}
