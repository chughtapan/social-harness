/**
 * @file Compiles a norm document: the Lisp frontend reads it as a norm, and
 * the norm is checked to be well formed. The checks read the norm alone,
 * whatever frontend produced it, so that the structure check never meets a
 * form that refers to something its norm lacks.
 */

import { Either } from "effect";
import { readNorm } from "./lisp.js";
import {
  type ActReference,
  type Delay,
  type Field,
  fieldOf,
  type Form,
  isName,
  type Norm,
  type Relation,
} from "./norm.js";

/** Whether a norm is well formed, or the first rule it breaks, in words that do not echo its document. */
type Checked = Either.Either<void, string>;

const NAME_RULE =
  "A norm, an act, a field and a fact each have a lowercase name: a letter, then letters, digits or hyphens, 64 characters at most.";

/** The well-formed norm `source` states, or why it states none. */
export function compileNorm(source: string): Either.Either<Norm, string> {
  return Either.flatMap(readNorm(source), (norm) =>
    Either.map(wellFormed(norm), () => norm),
  );
}

/**
 * Whether `norm` is well formed: its names are names, each performative has
 * one form and some form starts an instance, and every form is well formed
 * within it.
 */
function wellFormed(norm: Norm): Checked {
  const performatives = norm.forms.map((form) => form.performative);
  const facts = new Set(norm.forms.flatMap((form) => form.initiates));
  if (![norm.name, ...performatives, ...facts].every(isName)) {
    return Either.left(NAME_RULE);
  }
  if (new Set(performatives).size !== performatives.length) {
    return Either.left("An act has exactly one declared form.");
  }
  if (!norm.forms.some((form) => form.starts)) {
    return Either.left("Declare at least one opening act with :starts true.");
  }
  return Either.map(
    Either.all(norm.forms.map((form) => formed(norm, form, facts))),
    () => undefined,
  );
}

/**
 * Whether one form is well formed in its norm. Its fields are distinct and
 * bounded in order. Every fact it reads is one some form sets. A form that
 * starts an instance needs nothing earlier. Its delay and each of its
 * relations refer to fields of the right types.
 */
function formed(norm: Norm, form: Form, facts: ReadonlySet<string>): Checked {
  const fieldNames = form.fields.map((field) => field.name);
  if (!fieldNames.every((name) => isName(name) && name !== "ontology")) {
    return Either.left(`${NAME_RULE} No field is named ontology.`);
  }
  if (new Set(fieldNames).size !== fieldNames.length) {
    return Either.left("Field names must be unique within a form.");
  }
  if (!form.fields.every(bounded)) {
    return Either.left(
      "Field bounds must be ordered; length and item bounds are nonnegative integers.",
    );
  }
  if (form.max !== undefined && !(Number.isInteger(form.max) && form.max > 0)) {
    return Either.left(":max takes a positive integer.");
  }
  if (form.by.kind === "roles" && form.by.roles.length === 0) {
    return Either.left("An act's :by names client, server or both.");
  }
  if (form.by.kind === "recipient" && !facts.has(form.by.fact)) {
    return Either.left("A recipient sender selector names an undeclared fact.");
  }
  if (![...form.when, ...form.terminates].every((fact) => facts.has(fact))) {
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
  return Either.map(
    Either.all(form.relations.map((relation) => related(norm, form, relation))),
    () => undefined,
  );
}

/** Whether a field's bounds are ordered and, where they count code points or items, nonnegative integers. */
function bounded(field: Field): boolean {
  const { low, high, counts } = boundsOf(field);
  const ordered = low === undefined || high === undefined || low <= high;
  const counted = [low, high]
    .flatMap((bound) => bound ?? [])
    .every((bound) => Number.isInteger(bound) && bound >= 0);
  return ordered && (counted || !counts);
}

/** A field's lower and upper bound, and whether they count something: a string's code points or a list's items. */
function boundsOf(field: Field): {
  readonly low?: number;
  readonly high?: number;
  readonly counts: boolean;
} {
  switch (field.type) {
    case "string":
      return { low: field.minLength, high: field.maxLength, counts: true };
    case "integer":
      return { low: field.minimum, high: field.maximum, counts: false };
    case "list":
      return { low: field.minItems, high: field.maxItems, counts: true };
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

/** Whether a form that starts an instance needs nothing earlier: no fact, delay or relation, and senders named by role. */
function opens(form: Form): boolean {
  return (
    form.by.kind === "roles" &&
    form.when.length === 0 &&
    form.delay === undefined &&
    form.relations.length === 0
  );
}

/** Whether every form that sets a delay's fact requires the delay's field as a nonnegative integer. */
function anchored(norm: Norm, delay: Delay): boolean {
  const anchors = norm.forms.filter((form) =>
    form.initiates.includes(delay.fact),
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
 * Whether a relation's field and its source field are declared, on every
 * form the source may name, with the types its operator relates: `equals`
 * two fields of one type, `member` a string to a list, `subset` two lists.
 */
function related(
  norm: Norm,
  form: Form,
  { operator, field, source }: Relation,
): Checked {
  const candidate = fieldOf(form, field)?.type;
  const sources = referenced(norm, source.act).map(
    (target) => fieldOf(target, source.field)?.type,
  );
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

/** The forms an act reference may name: the one of its performative, or every form that sets its fact. */
function referenced(norm: Norm, reference: ActReference): readonly Form[] {
  return norm.forms.filter((form) =>
    reference.kind === "act"
      ? form.performative === reference.performative
      : form.initiates.includes(reference.fact),
  );
}
