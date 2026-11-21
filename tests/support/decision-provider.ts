/** @file A decision provider's answers, for the tests of the firewall and of what sits on it. */

import type {
  DecisionRequest,
  DecisionResponse,
} from "../../src/decision-provider.js";

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
  return {
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => {
        const selected = choices[question.ruleId] ?? otherwise;
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
