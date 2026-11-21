/**
 * @file Compiles a norm document: the Lisp frontend reads it as a norm, and
 * the norm must be well formed. The well-formedness rules read the norm
 * alone, whatever frontend produced it, so that the structure check never
 * meets a form that refers to something its norm lacks, or a turn rule it
 * cannot settle.
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
} from "./norm.js";

/** One well-formedness rule as it applies to a norm: whether the norm breaks it, and the rule in words that do not echo the norm's document. */
type Applied = readonly [broken: boolean, rule: string];

const NAME_RULE =
  "A norm, an act, a field and a fact each have a lowercase name: a letter, then letters, digits or hyphens, 64 characters at most.";

/** The well-formed norm `document` states, or why it states none. */
export function compileNorm(document: string): Either.Either<Norm, string> {
  return Either.flatMap(readNorm(document), (norm) =>
    Option.match(brokenRule(norm), {
      onNone: () => Either.right(norm),
      onSome: (rule) => Either.left(rule),
    }),
  );
}

/**
 * The first rule `norm` breaks, when it is not well formed: its names are
 * names, each performative has one form, some form starts an instance, and
 * every form is well formed within it.
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
 * The first rule one form breaks in its norm, where `facts` are the facts
 * some form sets. Its fields are distinct and their bounds ordered. Every
 * fact it reads is one of `facts`. A form that starts an instance needs
 * nothing earlier. Its delay and each of its relations refer to fields the
 * structure check will find.
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
        !form.fields.every(hasOrderedBounds),
        "Field bounds must be ordered; length and item bounds are nonnegative integers.",
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

/** Whether a field's bounds are ordered and, where they count code points or items, nonnegative integers. A field without bounds has them in order. */
function hasOrderedBounds(field: Field): boolean {
  const { low, high, counted } = boundsOf(field);
  const ordered = low === undefined || high === undefined || low <= high;
  const whole = [low, high]
    .flatMap((bound) => bound ?? [])
    .every((bound) => Number.isInteger(bound) && bound >= 0);
  return ordered && (whole || !counted);
}

/** A field's lower and upper bound, and whether they are counted: a string's code points or a list's items. */
function boundsOf(field: Field): {
  readonly low?: number;
  readonly high?: number;
  readonly counted: boolean;
} {
  switch (field.type) {
    case "string":
      return { low: field.minLength, high: field.maxLength, counted: true };
    case "integer":
      return { low: field.minimum, high: field.maximum, counted: false };
    case "list":
      return { low: field.minItems, high: field.maxItems, counted: true };
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

/** Whether a form that starts an instance needs nothing earlier: no fact, delay or relation, and senders named by role. */
function canStart(form: Form): boolean {
  return (
    form.by.kind === "roles" &&
    form.when.length === 0 &&
    form.delay === undefined &&
    form.relations.length === 0
  );
}

/**
 * Whether the structure check can always settle `delay` when it reaches it:
 * the form waits on the delay's fact, so the fact is set, and every form
 * that sets the fact requires the delay's field as a nonnegative integer.
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
 * The first rule a relation breaks. Its field is declared, and its source's
 * field is required on every form the source may name, so an earlier act
 * always states it. The types are those its operator compares: `equals` two
 * fields of one type, `member` a string with a list, `subset` two lists.
 */
function brokenRelationRule(
  norm: Norm,
  form: Form,
  { operator, field, source }: Relation,
): Option.Option<string> {
  const compared = fieldOf(form, field)?.type;
  const sources = formsOf(norm, source.act).map((earlier) =>
    fieldOf(earlier, source.field),
  );
  const expected = {
    equals: [compared, compared],
    member: ["string", "list"],
    subset: ["list", "list"],
  }[operator];
  return firstBroken([
    [
      compared === undefined ||
        sources.length === 0 ||
        sources.some((declared) => declared?.optional !== false),
      "A relation compares a declared field with a required field of every earlier act its source may name.",
    ],
    [
      compared !== expected[0] ||
        sources.some((declared) => declared?.type !== expected[1]),
      "An equals relation compares a field with one of its type, a member relation a string with a list, and a subset relation a list with a list.",
    ],
  ]);
}

/** The forms an earlier act may have: the one of its performative, or every form that sets its fact. */
function formsOf(norm: Norm, earlier: EarlierAct): readonly Form[] {
  return norm.forms.filter((form) =>
    earlier.kind === "performative"
      ? form.performative === earlier.performative
      : form.sets.includes(earlier.fact),
  );
}

/** The first rule of `applied` that is broken. */
function firstBroken(applied: readonly Applied[]): Option.Option<string> {
  return Option.map(
    Array.findFirst(applied, ([broken]) => broken),
    ([, rule]) => rule,
  );
}
