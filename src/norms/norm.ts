/**
 * @file The norm IR: a norm as the data a frontend produces and the
 * structure check runs over. A norm is a set of forms. Each form declares
 * one performative: the fields an act of it carries, which member may send
 * it, the facts that must be set before it, and the facts it sets and
 * clears. An act is what one message states: a performative, the norm it
 * belongs to and a value for each field it carries. Every value here is
 * plain data, so a norm prints as JSON.
 */

/** Which of a conversation's two members sends a message: the server agent, or its client. */
export type Role = "client" | "server";

/**
 * One norm. `document` is the text it was compiled from and `digest` the
 * SHA-256 of that text, which names exactly what both members read.
 */
export interface Norm {
  readonly name: string;
  readonly description: string;
  readonly forms: readonly Form[];
  readonly document: string;
  readonly digest: string;
}

/**
 * The form of one performative, and its turn rule. An act of it may follow
 * when its sender is one `by` permits, every fact of `when` is set, fewer
 * than `max` acts of it were sent in the instance, its `delay` has passed
 * and each of its `relations` is satisfied. Once allowed, it clears the
 * facts of `clears`, then sets those of `sets`. A form that `starts` begins
 * an instance, and one that `ends` finishes it.
 */
export interface Form {
  readonly performative: string;
  readonly by: Senders;
  readonly fields: readonly Field[];
  readonly starts: boolean;
  readonly ends: boolean;
  readonly when: readonly string[];
  readonly clears: readonly string[];
  readonly sets: readonly string[];
  readonly max?: number;
  readonly delay?: Delay;
  readonly relations: readonly Relation[];
}

/**
 * Which member may send an act: one that has any of `roles`, or the
 * recipient of the message that set `fact`, whichever role that is.
 */
export type Senders =
  | { readonly kind: "roles"; readonly roles: readonly Role[] }
  | { readonly kind: "recipient"; readonly fact: string };

/**
 * One field of a form. An act must state it unless it is `optional`. A
 * string's bounds count code points, an integer's bounds are inclusive, and
 * a list's bounds count its items, which are nonempty strings. A
 * `description` says what the field contains, and a decision provider
 * judges the text of a string or list field against it.
 */
export type Field = {
  readonly name: string;
  readonly optional: boolean;
  readonly description?: string;
} & (
  | {
      readonly type: "string";
      readonly minLength?: number;
      readonly maxLength?: number;
    }
  | {
      readonly type: "integer";
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | {
      readonly type: "list";
      readonly minItems?: number;
      readonly maxItems?: number;
    }
);

/**
 * A wait before an act: it may follow only once the act that set `fact` is
 * as many seconds old as that act's integer `field` says.
 */
export interface Delay {
  readonly fact: string;
  readonly field: string;
}

/**
 * What a field must be, against a field of an earlier act: `equals` it, a
 * `member` of its list, or a `subset` of its list.
 */
export interface Relation {
  readonly operator: "equals" | "member" | "subset";
  readonly field: string;
  readonly source: { readonly act: EarlierAct; readonly field: string };
}

/** An earlier act of the instance: the latest of a performative, or the one that set a fact. */
export type EarlierAct =
  | { readonly kind: "performative"; readonly performative: string }
  | { readonly kind: "fact"; readonly fact: string };

/** The value of a field in an act: text, a number or a list of texts. */
export type Value = string | number | readonly string[];

/** One act as a message states it: its performative, the name of its norm and the value of each field it carries. */
export interface Act {
  readonly performative: string;
  readonly norm: string;
  readonly fields: Readonly<Record<string, Value>>;
}

/**
 * Whether `text` may name a norm, a performative, a field or a fact: a
 * lowercase letter, then lowercase letters, digits or hyphens, 64 characters
 * at most.
 */
export function isName(text: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/u.test(text);
}

/** The field `name` of a form. */
export function fieldOf(form: Form, name: string): Field | undefined {
  return form.fields.find((field) => field.name === name);
}

/**
 * The fields of `form` that a decision provider judges: the string and list
 * fields that have a description, each with the subject its text rule names.
 * An integer is limited by its bounds alone.
 */
export function judgedFields(form: Form) {
  return form.fields.flatMap((field) =>
    field.type === "integer" || field.description === undefined
      ? []
      : [
          {
            name: field.name,
            subject:
              field.type === "list" ? `each item of ${field.name}` : field.name,
            description: field.description,
          },
        ],
  );
}
