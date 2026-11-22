/**
 * @file Compiles a norm document: parses it, then checks that the norm is
 * well formed.
 *
 * The well-formedness rules work on the parsed norm, not on its text. They
 * guarantee what the structure check relies on: every fact, field and act a
 * form refers to exists, and every turn rule can be evaluated.
 */

import { Array, Either, Option } from "effect";
import { readNorm } from "./lisp.js";
import {
  type Delay,
  type EarlierAct,
  type Field,
  fieldOf,
  type Form,
  isName,
  type Norm,
  type Relation,
  type Shape,
} from "./norm.js";

/** One rule applied to a norm: whether the norm breaks it, and the rule's text. The text never quotes the document. */
type Applied = readonly [broken: boolean, rule: string];

const NAME_RULE =
  "A norm, an act, a field and a fact each have a lowercase name: a letter, then letters, digits or hyphens, 64 characters at most.";

/** Compiles a document into a norm. Fails with the reason if it does not parse or is not well formed. */
export function compileNorm(document: string): Either.Either<Norm, string> {
  return Either.flatMap(readNorm(document), (norm) =>
    Option.match(brokenRule(norm), {
      onNone: () => Either.right(norm),
      onSome: (rule) => Either.left(rule),
    }),
  );
}

/**
 * Returns the first rule the norm breaks, if any. The rules: every name is
 * a valid name, each performative has exactly one form, at least one form
 * starts an instance, and every form is well formed.
 */
function brokenRule(norm: Norm): Option.Option<string> {
  const performatives = norm.forms.map((form) => form.performative);
  const facts = new Set(norm.forms.flatMap((form) => form.sets));
  return Option.orElse(
    firstBroken([
      [![norm.name, ...performatives, ...facts].every(isName), NAME_RULE],
      [
        new Set(performatives).size !== performatives.length,
        "An act has exactly one declared form.",
      ],
      [
        !norm.forms.some((form) => form.starts),
        "Declare at least one act with :starts true.",
      ],
    ]),
    () =>
      Option.firstSomeOf(
        norm.forms.map((form) => brokenFormRule(norm, form, facts)),
      ),
  );
}

/**
 * Returns the first rule a form breaks, if any. `facts` holds every fact
 * that some form in the norm sets.
 *
 * The main rules: field names are valid and unique, and bounds are in
 * order. `max` is a positive integer. Every fact the form reads or clears
 * is in `facts`. A form that starts an instance depends on no earlier act.
 * A delay and each relation refer only to fields that the earlier act is
 * guaranteed to have.
 */
function brokenFormRule(
  norm: Norm,
  form: Form,
  facts: ReadonlySet<string>,
): Option.Option<string> {
  const fieldNames = form.fields.map((field) => field.name);
  const { by, max, delay } = form;
  return Option.orElse(
    firstBroken([
      [!fieldNames.every(isName), NAME_RULE],
      [
        new Set(fieldNames).size !== fieldNames.length,
        "Field names must be unique within a form.",
      ],
      [
        !form.fields.every(isWellShaped),
        "Field bounds must be ordered; length and item bounds are nonnegative integers; a record's fields have distinct names.",
      ],
      [
        max !== undefined && !(Number.isInteger(max) && max > 0),
        ":max takes a positive integer.",
      ],
      [
        by.kind === "roles" && by.roles.length === 0,
        "An act's :by names client, server or both.",
      ],
      [
        by.kind === "recipient" && !facts.has(by.fact),
        "A recipient sender selector names a fact no act sets.",
      ],
      [
        ![...form.when, ...form.clears].every((fact) => facts.has(fact)),
        ":when and :clears name facts some act sets.",
      ],
      [
        form.starts && !canStart(form),
        "An act that starts an instance names its senders by role and cannot depend on an earlier act.",
      ],
      [
        delay !== undefined && !canWait(norm, form, delay),
        "A delay waits on a fact of its act's :when, and names a required nonnegative integer field of every act that sets that fact.",
      ],
    ]),
    () =>
      Option.firstSomeOf(
        form.relations.map((relation) =>
          brokenRelationRule(norm, form, relation),
        ),
      ),
  );
}

/**
 * Whether a shape is well formed. Its lower bound is at most its upper
 * bound, and for a string or a list both are whole numbers of zero or more.
 * A record's field names are valid and unique. A list's item and a record's
 * fields are well formed in turn.
 */
function isWellShaped(shape: Shape): boolean {
  const { low, high, counted } = boundsOf(shape);
  const ordered = low === undefined || high === undefined || low <= high;
  const whole = [low, high]
    .flatMap((bound) => bound ?? [])
    .every((bound) => Number.isInteger(bound) && bound >= 0);
  if (!ordered || (counted && !whole)) {
    return false;
  }
  if (shape.type === "list") {
    return shape.item === undefined || isWellShaped(shape.item);
  }
  if (shape.type !== "record") {
    return true;
  }
  const names = shape.fields.map((field) => field.name);
  return (
    names.every(isName) &&
    new Set(names).size === names.length &&
    shape.fields.every(isWellShaped)
  );
}

/** A shape's lower and upper bound. `counted` is true for a string or a list, whose bounds count code points or items. */
function boundsOf(shape: Shape): {
  readonly low?: number;
  readonly high?: number;
  readonly counted: boolean;
} {
  switch (shape.type) {
    case "string":
      return { low: shape.minLength, high: shape.maxLength, counted: true };
    case "integer":
    case "number":
      return { low: shape.minimum, high: shape.maximum, counted: false };
    case "list":
      return { low: shape.minItems, high: shape.maxItems, counted: true };
    case "boolean":
    case "record":
      return { counted: false };
    default: {
      const exhaustive: never = shape;
      return exhaustive;
    }
  }
}

/** The type of a list's items, which are strings when it declares no item. */
function itemTypeOf(shape: Shape): string | undefined {
  return shape.type === "list" ? (shape.item?.type ?? "string") : undefined;
}

/** Whether a form can start an instance: it names its senders by role and has no `when` fact, delay or relation. */
function canStart(form: Form): boolean {
  return (
    form.by.kind === "roles" &&
    form.when.length === 0 &&
    form.delay === undefined &&
    form.relations.length === 0
  );
}

/**
 * Whether the structure check can always evaluate `delay`. Two things make
 * that true. The form lists the delay's fact in `when`, so the fact is set
 * whenever the delay is checked. And every form that sets the fact requires
 * the seconds field as an integer of zero or more.
 */
function canWait(norm: Norm, form: Form, delay: Delay): boolean {
  return (
    form.when.includes(delay.fact) &&
    norm.forms
      .filter((setter) => setter.sets.includes(delay.fact))
      .every((setter) => {
        const field = fieldOf(setter, delay.secondsField);
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
 * Returns the first rule a relation breaks, if any.
 *
 * The relation's field must be declared on the form. The source's field must
 * be required on every form the source can refer to, so the earlier act
 * always has it. The field types must suit the operator: `equals` compares
 * two fields of the same type, `member` a field with a list whose items have
 * its type, and `subset` two lists whose items have the same type.
 */
function brokenRelationRule(
  norm: Norm,
  form: Form,
  { operator, field, source }: Relation,
): Option.Option<string> {
  const compared = fieldOf(form, field);
  const sources = formsOf(norm, source.act).map((earlier) =>
    fieldOf(earlier, source.field),
  );
  const suits = (declared: Field) => {
    switch (operator) {
      case "equals":
        return declared.type === compared?.type;
      case "member":
        return itemTypeOf(declared) === compared?.type;
      case "subset":
        return (
          compared?.type === "list" &&
          itemTypeOf(declared) === itemTypeOf(compared)
        );
      default: {
        const exhaustive: never = operator;
        return exhaustive;
      }
    }
  };
  return firstBroken([
    [
      compared === undefined ||
        sources.length === 0 ||
        sources.some((declared) => declared?.optional !== false),
      "A relation compares a declared field with a required field of every earlier act its source may name.",
    ],
    [
      !sources.every((declared) => declared !== undefined && suits(declared)),
      "An equals relation compares two fields of one type, a member relation a field with a list of items of its type, and a subset relation two lists with items of one type.",
    ],
  ]);
}

/** The forms an earlier-act reference can refer to: the form with that performative, or every form that sets that fact. */
function formsOf(norm: Norm, earlier: EarlierAct): readonly Form[] {
  return norm.forms.filter((form) =>
    earlier.kind === "performative"
      ? form.performative === earlier.performative
      : form.sets.includes(earlier.fact),
  );
}

/** Returns the text of the first broken rule in the list. */
function firstBroken(applied: readonly Applied[]): Option.Option<string> {
  return Option.map(
    Array.findFirst(applied, ([broken]) => broken),
    ([, rule]) => rule,
  );
}
