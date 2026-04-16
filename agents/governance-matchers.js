/**
 * Governance matchers (MP-17 relay g7c-2).
 *
 * Two distinct entry points over the same underlying clause-matching intelligence:
 *
 *   matchConstitutional(action, constitutionDoc)  → CONSTITUTIONAL | UNCONSTITUTIONAL | INDETERMINATE
 *   matchScope(action, governanceDoc)             → IN_SCOPE | OUT_OF_SCOPE | AMBIGUOUS
 *
 * Both wrappers delegate to a shared `clauseMatcher` instance (from agents/clause-matcher.js).
 * The matcher's three-way output (IN_SCOPE/OUT_OF_SCOPE/AMBIGUOUS) is mapped to the
 * constitutional vocabulary when the caller is Tier 0. This keeps the LLM-backed
 * evaluation logic in exactly one place while giving callers the verdict vocabulary
 * MP-17 §"Arbiter (#190) — Two-Tier Scope Check" requires.
 *
 * Dependency-injected so tests can substitute lightweight stubs without touching LLM
 * machinery. Production wires the real clause-matcher at Arbiter boot.
 */

const VERDICT_MAP_CONSTITUTIONAL = {
  IN_SCOPE: 'CONSTITUTIONAL',
  OUT_OF_SCOPE: 'UNCONSTITUTIONAL',
  AMBIGUOUS: 'INDETERMINATE',
};

/**
 * Tier-0 constitutional compliance check. Uses the Constitution (from Graph)
 * as the governance reference. UNCONSTITUTIONAL outcomes are absolute per
 * MP-17 binding decision #34 — the route handler must not PEM-escalate.
 *
 * @param {object} params
 * @param {string} params.action
 * @param {string[]} [params.targets]
 * @param {string} [params.intent]
 * @param {object} params.constitution — shape from conceptToBorDocShape
 * @param {object} params.clauseMatcher — object with .evaluate({action,targets,intent,bor})
 * @returns {Promise<{verdict, matched_rules, confidence, reasoning}>}
 */
export async function matchConstitutional({ action, targets = [], intent = '', constitution, clauseMatcher }) {
  if (!constitution) {
    return {
      verdict: 'INDETERMINATE',
      matched_rules: [],
      confidence: 0,
      reasoning: 'Constitution not available in Graph.',
    };
  }
  const result = await clauseMatcher.evaluate({ action, targets, intent, bor: constitution });
  return {
    verdict: VERDICT_MAP_CONSTITUTIONAL[result.determination] || 'INDETERMINATE',
    matched_rules: (result.cited_clauses || []).map((c) => c.clause_id).filter(Boolean),
    confidence: result.confidence ?? 0,
    reasoning: result.reasoning || '',
  };
}

/**
 * Tier-1 entity/vivan scope check. Uses the supplied governance doc (entity BoR
 * or the Vivan's resolved effective governance) as the reference.
 *
 * @param {object} params
 * @param {string} params.action
 * @param {string[]} [params.targets]
 * @param {string} [params.intent]
 * @param {object|null} params.governance — shape from conceptToBorDocShape, or null
 *     when no governance document exists for the tenant (e.g., new entity without
 *     published BoR yet). Null governance → AMBIGUOUS by default (safe restriction).
 * @param {object} params.clauseMatcher
 * @returns {Promise<{verdict, matched_rules, confidence, reasoning}>}
 */
export async function matchScope({ action, targets = [], intent = '', governance, clauseMatcher }) {
  if (!governance) {
    return {
      verdict: 'AMBIGUOUS',
      matched_rules: [],
      confidence: 0,
      reasoning: 'No governance document available for this tenant.',
    };
  }
  const result = await clauseMatcher.evaluate({ action, targets, intent, bor: governance });
  return {
    verdict: result.determination, // IN_SCOPE | OUT_OF_SCOPE | AMBIGUOUS — already the right vocabulary
    matched_rules: (result.cited_clauses || []).map((c) => c.clause_id).filter(Boolean),
    confidence: result.confidence ?? 0,
    reasoning: result.reasoning || '',
  };
}
