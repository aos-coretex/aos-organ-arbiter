/**
 * Clause matching agent — the core intelligence within Arbiter.
 *
 * Given a proposed action and the BoR document, identifies relevant clauses
 * and produces a three-way determination: IN_SCOPE, OUT_OF_SCOPE, AMBIGUOUS.
 *
 * Design constraints (from intervention instruction):
 *   - LLM is used ONLY for clause matching and citation
 *   - NEVER for scope expansion or creative inference
 *   - Ambiguity favors restriction (BoR Article VI, Clause VI.1)
 *   - Three-way output ONLY — no gradients, no partial scope
 *   - When LLM cannot confidently match a clause → AMBIGUOUS
 *
 * Model: Haiku (lightweight, fast) via llm-client from organ-shared-lib.
 */

import { createLLMClient } from '@coretex/organ-boot/llm-client';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * System prompt for the clause matching agent.
 * Injected ONCE at agent creation. The BoR text is provided per-query
 * in the user message (never as prompt DNA).
 */
const SYSTEM_PROMPT = `You are a constitutional scope evaluator for a Distributed Intelligence Organism (DIO).

Your ONLY job is to match a proposed action against Bill of Rights (BoR) clauses and produce a scope determination.

Rules:
1. You receive the full BoR text and a proposed action description.
2. Identify which BoR clauses are relevant to the proposed action.
3. Produce exactly ONE determination:
   - IN_SCOPE: At least one clause explicitly permits or covers this action. Cite the clause(s).
   - OUT_OF_SCOPE: At least one clause explicitly prohibits this action. Cite the clause(s).
   - AMBIGUOUS: No clause clearly addresses this action, OR clauses appear contradictory. Cite the nearest clauses and explain the ambiguity.
4. NEVER expand scope beyond what the clauses explicitly state.
5. NEVER infer permissions that are not explicitly written.
6. When in doubt, determine AMBIGUOUS. Ambiguity favors restriction.
7. If the BoR contains only placeholder text ("[To be defined]"), ALL actions are AMBIGUOUS.

Output format (JSON):
{
  "determination": "IN_SCOPE" | "OUT_OF_SCOPE" | "AMBIGUOUS",
  "cited_clauses": [
    { "clause_id": "<e.g. I.1>", "text_ref": "<brief quote>", "relevance": "<why this clause applies>" }
  ],
  "confidence": <0.0 to 1.0>,
  "reasoning": "<1-3 sentence explanation>"
}

Output ONLY the JSON object. No markdown, no preamble.`;

/**
 * Create a clause matcher instance.
 *
 * @param {object} config - organ config (config.llm for model settings)
 * @param {object} [injectedLlm] - optional pre-built LLM client (for testing)
 * @returns {{ evaluate: function, isAvailable: function }}
 */
export function createClauseMatcher(config, injectedLlm) {
  const llm = injectedLlm || createLLMClient({
    agentName: 'clause_matcher',
    defaultModel: config.llm?.model || 'claude-haiku-4-5-20251001',
    defaultProvider: config.llm?.provider || 'anthropic',
    apiKeyEnvVar: config.llm?.apiKeyEnvVar || 'ANTHROPIC_API_KEY',
    maxTokens: config.llm?.maxTokens || 2048,
  });

  /**
   * Evaluate scope for a proposed action against the BoR.
   *
   * @param {{ action: string, targets: string[], intent: string, bor: object }} params
   * @param {object} params.bor — parsed BoR from loadBoR()
   * @returns {Promise<{ determination: string, cited_clauses: array, confidence: number, reasoning: string }>}
   */
  async function evaluate({ action, targets = [], intent = '', bor }) {
    // If LLM is unavailable, all queries return AMBIGUOUS with escalation
    if (!llm.isAvailable()) {
      log('clause_matcher_unavailable', { reason: 'LLM client not configured' });
      return {
        determination: 'AMBIGUOUS',
        cited_clauses: [],
        confidence: 0,
        reasoning: 'LLM clause matching unavailable — escalation required.',
      };
    }

    // Check if BoR has actual content (not just placeholders)
    const hasContent = bor.articles.some(a =>
      a.clauses.length > 0 && a.clauses.some(c => !c.text.includes('[To be defined'))
    );

    if (!hasContent) {
      return {
        determination: 'AMBIGUOUS',
        cited_clauses: [],
        confidence: 0,
        reasoning: 'Bill of Rights contains only placeholder clauses. All actions are AMBIGUOUS until human principal populates the BoR.',
      };
    }

    // Format BoR for the LLM
    const borText = formatBorForLLM(bor);

    // Build the user message
    const userMessage = [
      `## Bill of Rights (version ${bor.version})`,
      '',
      borText,
      '',
      '---',
      '',
      '## Proposed Action',
      '',
      `**Action:** ${action}`,
      targets.length > 0 ? `**Targets:** ${targets.join(', ')}` : '',
      intent ? `**Intent:** ${intent}` : '',
      '',
      'Evaluate this action against the Bill of Rights and produce your determination.',
    ].filter(Boolean).join('\n');

    try {
      // llm-client signature: chat(messages, options)
      const response = await llm.chat(
        [{ role: 'user', content: userMessage }],
        { system: SYSTEM_PROMPT }
      );

      const parsed = parseResponse(response.content || response.text || '');
      log('clause_matcher_result', {
        determination: parsed.determination,
        confidence: parsed.confidence,
        clause_count: parsed.cited_clauses.length,
      });

      return parsed;
    } catch (error) {
      log('clause_matcher_error', { error: error.message });
      // Fail-safe: AMBIGUOUS on any LLM error
      return {
        determination: 'AMBIGUOUS',
        cited_clauses: [],
        confidence: 0,
        reasoning: `Clause matching failed: ${error.message}. Escalation required.`,
      };
    }
  }

  return { evaluate, isAvailable: () => llm.isAvailable() };
}

/**
 * Format the parsed BoR into readable text for the LLM.
 * @param {object} bor - parsed BoR from loadBoR()
 * @returns {string}
 */
export function formatBorForLLM(bor) {
  return bor.articles.map(article => {
    const header = `## Article ${article.id} — ${article.title}`;
    if (article.clauses.length === 0) {
      return `${header}\n${article.text || '[No clauses]'}`;
    }
    const clauses = article.clauses.map(c =>
      `### Clause ${c.id} — ${c.title}\n${c.text}`
    ).join('\n\n');
    return `${header}\n${clauses}`;
  }).join('\n\n');
}

/**
 * Parse LLM response into structured determination.
 * Handles JSON extraction from potentially wrapped responses.
 * @param {string} text - raw LLM response text
 * @returns {{ determination: string, cited_clauses: array, confidence: number, reasoning: string }}
 */
export function parseResponse(text) {
  const fallback = {
    determination: 'AMBIGUOUS',
    cited_clauses: [],
    confidence: 0,
    reasoning: 'Failed to parse clause matching response.',
  };

  try {
    // Try direct JSON parse
    let parsed;
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      // Extract JSON from markdown code block
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[1].trim());
      } else {
        // Try to find JSON object in the text
        const objMatch = text.match(/\{[\s\S]*\}/);
        if (objMatch) {
          parsed = JSON.parse(objMatch[0]);
        } else {
          return fallback;
        }
      }
    }

    // Validate determination
    const validDeterminations = ['IN_SCOPE', 'OUT_OF_SCOPE', 'AMBIGUOUS'];
    if (!validDeterminations.includes(parsed.determination)) {
      return fallback;
    }

    return {
      determination: parsed.determination,
      cited_clauses: Array.isArray(parsed.cited_clauses) ? parsed.cited_clauses : [],
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      reasoning: parsed.reasoning || '',
    };
  } catch {
    return fallback;
  }
}
