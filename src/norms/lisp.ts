/**
 * @file The Lisp syntax of the norm language. It parses a norm document into
 * a norm and a message's text into an act. Both are parenthesized data, and
 * nothing in them is evaluated.
 *
 * This file checks syntax only. The compiler checks that a norm is well
 * formed, and the structure check decides whether an act may be sent.
 */

import { Either } from "effect";
import { createHash } from "node:crypto";
import {
  type Act,
  type Delay,
  type Field,
  type FieldValue,
  type Form,
  type Format,
  FORMATS,
  isName,
  type Norm,
  type Relation,
  type Role,
  type Senders,
  type Shape,
} from "./norm.js";

/** A parse result: the value, or an error message. */
type Read<A> = Either.Either<A, string>;

/** A parsed value: a symbol, a quoted string or a list. */
type SExpression =
  | { readonly kind: "symbol"; readonly value: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "list"; readonly values: readonly SExpression[] };

/**
 * One declaration of a document, such as `(act offer :by server ...)`: its
 * keyword, its name, its `:attribute value` pairs and its remaining items.
 */
interface Declaration {
  readonly kind: string;
  readonly name?: string;
  readonly attributes: ReadonlyMap<string, SExpression>;
  readonly children: readonly SExpression[];
}

/** Matches a symbol that is a number, using JSON's number syntax. */
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

/**
 * Instructions for writing an act, addressed to an agent. They are appended
 * to the description of the `read_norms` tool.
 */
export const ACT_SYNTAX =
  'A message is one act and nothing else: (<performative> :norm <norm> :<field> <value> ...). Quote text as a JSON string, write a number or true or false bare, write a list as values in parentheses such as ("first" "second"), write a record as (:<name> <value> ...), and send an act without fields as (<performative> :norm <norm>). The act that starts an instance omits replyToMsgId in send_message; every later act supplies the id of the message it answers.';

/** The bound attributes each field type accepts. */
const bounds = {
  string: [":min-length", ":max-length"],
  integer: [":minimum", ":maximum"],
  number: [":minimum", ":maximum"],
  boolean: [],
  list: [":min-items", ":max-items"],
  record: [],
} as const;

type TypeName = keyof typeof bounds;

/** Parses a norm document: one `norm` declaration followed by one `act` declaration per form. */
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
 * Parses a message's text as an act. The whole text must be one list: a
 * performative followed by `:field value` pairs. The `:norm` pair names the
 * act's norm.
 *
 * A value is text, a number, a boolean, a list of values or a record, as
 * `readValue` describes. Comments are not allowed in a message.
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
    const { norm, ...fields } = yield* readRecord(parameters);
    if (typeof norm !== "string") {
      return yield* Either.left(":norm must name the act's norm.");
    }
    return { performative, norm, fields };
  });
}

/**
 * Reads a value. A quoted string is text. A bare symbol is a number if it
 * looks like one, a boolean if it is `true` or `false`, and text otherwise.
 * A list whose first item is a `:name` is a record, and any other list is a
 * list of values.
 */
function readValue(node: SExpression): Read<FieldValue> {
  if (node.kind === "string") {
    return Either.right(node.value);
  }
  if (node.kind === "list") {
    const first = symbol(node.values[0]);
    return first?.startsWith(":") === true
      ? readRecord(node.values)
      : Either.all(node.values.map(readValue));
  }
  if (node.value === "true" || node.value === "false") {
    return Either.right(node.value === "true");
  }
  if (!NUMBER.test(node.value)) {
    return Either.right(node.value);
  }
  return Number.isFinite(Number(node.value))
    ? Either.right(Number(node.value))
    : Either.left("Numbers must be finite.");
}

/** Reads `:name value` pairs as a record. Each name may appear once. */
function readRecord(
  pairs: readonly SExpression[],
): Read<Readonly<Record<string, FieldValue>>> {
  return Either.gen(function* () {
    const fields = new Map<string, FieldValue>();
    for (let index = 0; index < pairs.length; index += 2) {
      const key = symbol(pairs[index]);
      const value = pairs[index + 1];
      if (
        key?.startsWith(":") !== true ||
        !isName(key.slice(1)) ||
        value === undefined ||
        fields.has(key.slice(1))
      ) {
        return yield* Either.left(
          "Parameters must have distinct :names and one value each.",
        );
      }
      fields.set(key.slice(1), yield* readValue(value));
    }
    return Object.fromEntries(fields);
  });
}

/** Parses an `act` declaration into a form. Its attributes give the turn rule, and its child lists give the fields and relations. */
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
        children
          .filter(({ kind }) => kind === "field")
          .map((child) => readField(child)),
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

/** Parses `:by`, which says who may send the act: `client`, `server`, both, or `(recipient (fact name))`. */
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

/** Parses a delay, written `:after (fact field)`: the fact to wait on, then the field of the act that set it which holds the number of seconds. */
function readDelay(form: Declaration): Read<Delay | undefined> {
  const after = form.attributes.get(":after");
  if (after === undefined) {
    return Either.right(undefined);
  }
  const [fact, secondsField, ...more] =
    after.kind === "list" ? after.values.map((item) => symbol(item)) : [];
  return fact === undefined || secondsField === undefined || more.length > 0
    ? Either.left(":after takes a fact and a field of seconds: (fact field).")
    : Either.right({ fact, secondsField });
}

/**
 * Parses a `field` declaration: its name, whether it is optional, its
 * description and its shape. A field may not be named `norm`. A field inside
 * a record takes no description, because text rules judge whole fields.
 */
function readField(form: Declaration, nested = false): Read<Field> {
  return Either.gen(function* () {
    if (form.name === undefined || form.name === "norm") {
      return yield* Either.left(
        "A field needs a name, and none is named norm: an act names its norm with :norm.",
      );
    }
    if (nested && form.attributes.has(":description")) {
      return yield* Either.left(
        "Describe the field that holds a record, not the fields inside it.",
      );
    }
    return {
      name: form.name,
      optional: yield* booleanAttribute(form, ":optional"),
      description: yield* textAttribute(form, ":description"),
      ...(yield* readShape(form, [":optional", ":description"])),
    };
  });
}

/**
 * Parses the shape a `field` or `item` declaration gives: its type, the
 * bounds and format that type accepts, a record's fields and a list's item.
 * `also` lists the other attributes the declaration may carry.
 */
function readShape(form: Declaration, also: readonly string[]): Read<Shape> {
  return Either.gen(function* () {
    const type = Object.keys(bounds).find(
      (known): known is TypeName =>
        known === symbol(form.attributes.get(":type")),
    );
    if (type === undefined) {
      return yield* Either.left(
        ":type takes string, integer, number, boolean, list or record.",
      );
    }
    const children = yield* readChildren(form, type);
    const formatted =
      type === "string" || (type === "list" && children.length === 0);
    yield* checkAttributes(form, [
      ":type",
      ...also,
      ...bounds[type],
      ...(formatted ? [":format"] : []),
    ]);
    const [low, high] = yield* Either.all(
      bounds[type].map((bound) => numberAttribute(form, bound)),
    );
    switch (type) {
      case "string":
        return {
          type,
          minLength: low,
          maxLength: high,
          format: yield* readFormat(form),
        };
      case "integer":
      case "number":
        return { type, minimum: low, maximum: high };
      case "boolean":
        return { type };
      case "list": {
        const [item] = children;
        return {
          type,
          minItems: low,
          maxItems: high,
          format: yield* readFormat(form),
          item: item === undefined ? undefined : yield* readShape(item, []),
        };
      }
      case "record":
        return {
          type,
          fields: yield* Either.all(
            children.map((child) => readField(child, true)),
          ),
        };
      default: {
        const exhaustive: never = type;
        return exhaustive;
      }
    }
  });
}

/** Parses the child declarations a type allows: fields in a record, at most one item in a list, and none in any other type. */
function readChildren(
  form: Declaration,
  type: TypeName,
): Read<readonly Declaration[]> {
  return Either.flatMap(
    Either.all(form.children.map(readDeclaration)),
    (children) => {
      const allowed: Partial<Record<TypeName, string>> = {
        record: "field",
        list: "item",
      };
      const fits =
        children.every(({ kind }) => kind === allowed[type]) &&
        (type !== "list" || children.length <= 1);
      return fits
        ? Either.right(children)
        : Either.left(
            "A record contains fields, a list at most one item, and other fields nothing.",
          );
    },
  );
}

/** Reads `:format`, or undefined if the declaration has none. */
function readFormat(form: Declaration): Read<Format | undefined> {
  const format = FORMATS.find(
    (known) => known === symbol(form.attributes.get(":format")),
  );
  return form.attributes.has(":format") && format === undefined
    ? Either.left(":format takes date, time, date-time or duration.")
    : Either.right(format);
}

/** Parses a relation, written `(relation operator field (previous act field))`. */
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

/** Parses a relation's source, written `(previous act field)`. The act is a performative or `(fact name)`. */
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

/** Returns the name in `(fact name)`, or undefined if the node is not that. */
function factOf(node?: SExpression): string | undefined {
  return node?.kind === "list" &&
    node.values.length === 2 &&
    symbol(node.values[0]) === "fact"
    ? symbol(node.values[1])
    : undefined;
}

/** Parses a list into a declaration. The first item is the keyword. For `norm`, `act`, `field` and `relation`, the second item is the name. */
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

/** Splits the items after a declaration's name into `:attribute value` pairs and child items. */
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

/** Fails if the declaration has an attribute outside `allowed`, which catches a misspelled attribute. */
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

/** Reads an attribute's value as a list of names. The value is one symbol or a list of symbols. A missing attribute gives an empty list. */
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

/** Reads a `true` or `false` attribute. A missing attribute is false. */
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

/** Reads a number attribute, or undefined if it is missing. */
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

/** Reads a quoted-string attribute, or undefined if it is missing. */
function textAttribute(
  form: Declaration,
  key: string,
): Read<string | undefined> {
  const node = form.attributes.get(key);
  return node === undefined || node.kind === "string"
    ? Either.right(node?.value)
    : Either.left(`${key} takes a quoted string.`);
}

/** Returns the node's text if it is a symbol. */
function symbol(node?: SExpression): string | undefined {
  return node?.kind === "symbol" ? node.value : undefined;
}

/**
 * Parses `text` into its top-level expressions: parenthesized lists, strings
 * quoted with JSON escaping, and symbols, which are any other run of
 * characters.
 *
 * A `;` starts a comment that runs to the end of the line. Documents may
 * have comments. Messages may not, so that every token of a message is part
 * of its act. An error reports the offset of the bad token, or the end of
 * the text for an unclosed parenthesis.
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

/** Adds one token to the innermost open list, skipping whitespace and allowed comments. Returns an error message if the token is not acceptable. */
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
