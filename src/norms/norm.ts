/**
 * @file The data model of a norm. The parser produces these values and the
 * structure check runs on them. Every type here is plain data that prints
 * as JSON.
 *
 * An act is one message's content: a performative, a norm name and field
 * values. A performative is the name of a kind of act, such as `offer`. An
 * instance is one run of a norm in a conversation, from an act that starts
 * it to an act that ends it. A fact is a named flag of an instance, which
 * acts set and clear.
 *
 * A norm is a set of forms, one per performative. A form says which fields
 * an act carries, who may send it, which facts must be set first, and which
 * facts it sets and clears.
 */

/** The member of a conversation that sends a message: the client or the server agent. */
export type Role = "client" | "server";

/**
 * One norm. `document` is the text it was compiled from, and `digest` is
 * the SHA-256 of that text.
 */
export interface Norm {
  readonly name: string;
  readonly description: string;
  readonly forms: readonly Form[];
  readonly document: string;
  readonly digest: string;
}

/**
 * The form of one performative, including its turn rule: the conditions
 * for sending an act of it.
 *
 * The form requires all of these: `by` permits the sender, every fact in
 * `when` is set, fewer than `max` acts of this performative were sent in
 * the instance, the `delay` has passed, and every relation in `relations`
 * is satisfied. The structure check also requires a valid reply reference.
 *
 * `starts` means the act starts an instance, and `ends` means it ends one.
 * When an act that does not end the instance passes, the facts in `clears`
 * are cleared and then the facts in `sets` are set.
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
 * Who may send an act: a member with one of `roles`, or the member that
 * received the message which set `fact`.
 */
export type Senders =
  | { readonly kind: "roles"; readonly roles: readonly Role[] }
  | { readonly kind: "recipient"; readonly fact: string };

/**
 * One field of a form. An act must include it unless it is `optional`.
 *
 * All bounds are inclusive. A string's bounds count code points and a
 * list's count items. Each list item is a nonempty string.
 * `description` says what the field should contain. For a string or list
 * field, the decision provider judges the field's text against it.
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
 * A required wait before an act. The earlier act that set `fact` carries a
 * number of seconds in its field `secondsField`. The new act may be sent
 * only once that many seconds have passed since the earlier act.
 */
export interface Delay {
  readonly fact: string;
  readonly secondsField: string;
}

/**
 * A constraint between a field of this act and a field of an earlier act.
 * `field` must equal the source field (`equals`), be one of its items
 * (`member`), or have only items found in it (`subset`).
 */
export interface Relation {
  readonly operator: "equals" | "member" | "subset";
  readonly field: string;
  readonly source: { readonly act: EarlierAct; readonly field: string };
}

/** A reference to an earlier act in the reply chain: the latest act with a given performative, or the act that set a given fact. */
export type EarlierAct =
  | { readonly kind: "performative"; readonly performative: string }
  | { readonly kind: "fact"; readonly fact: string };

/** A field's value: text, a number or a list of texts. */
export type FieldValue = string | number | readonly string[];

/** One act. `fields` maps each field name the act includes to its value. */
export interface Act {
  readonly performative: string;
  readonly norm: string;
  readonly fields: Readonly<Record<string, FieldValue>>;
}

/**
 * Whether `text` is a valid name for a norm, performative, field or fact: a
 * lowercase letter followed by lowercase letters, digits or hyphens, at
 * most 64 characters in all.
 */
export function isName(text: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/u.test(text);
}

/** Finds a form's field by name, or returns undefined. */
export function fieldOf(form: Form, name: string): Field | undefined {
  return form.fields.find((field) => field.name === name);
}

/**
 * The fields of a form that the decision provider judges: string and list
 * fields that have a description. `subject` is how the field's text rule
 * refers to it. Integer fields are never judged.
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
