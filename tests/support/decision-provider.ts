/** @file A decision provider's answers, for the tests of the firewall and of what sits on it. */

import { Schema } from "effect";
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
} from "../../src/decision-provider.js";

/** How a test's provider answers. The test's firewall gives it its limits. */
export type Answering = Pick<DecisionProvider, "answer">;

/** One answer exactly as a provider reports it. */
export type Answer = DecisionResponse["answers"][string];

/**
 * A provider's answer to each question of `request`: the choice `choices`
 * gives the question's rule, with certainty unless it is a full answer, and
 * `otherwise` for every other rule.
 */
export function answersTo(
  request: DecisionRequest,
  choices: Readonly<Record<string, string | Answer>> = {},
  otherwise = "compliant",
): DecisionResponse {
  const ruleIds = ruleIdsOf(request);
  return {
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, question], index) => {
        const selected = choices[ruleIds[index] ?? ""] ?? otherwise;
        return [
          id,
          typeof selected === "string"
            ? {
                choice: selected,
                probabilities: Object.fromEntries(
                  Object.keys(question.criteria).map((choice) => [
                    choice,
                    Number(choice === selected),
                  ]),
                ),
              }
            : selected,
        ];
      }),
    ),
  };
}

/** The id of the rule each question of `request` asks about, in question order. */
export function ruleIdsOf(request: DecisionRequest): readonly string[] {
  const state: unknown = JSON.parse(request.state);
  return Schema.decodeUnknownSync(
    Schema.Struct({
      rules: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  )(state).rules.map((rule) => rule.id);
}
