/**
 * Scope query routes — MP-17 two-tier scope check.
 *
 * POST /scope-query   — Tier 0 (Constitution) + Tier 1 (entity/vivan/platform)
 * GET  /determinations — audit trail of past determinations
 *
 * Contract (MP-17 binding decisions #32–#35):
 *   Request: {
 *     ap_ref: string,
 *     action: string,
 *     targets?: string[],
 *     intent?: string,
 *     tenant_urn: string,                         // required, no default-through
 *     tenant_type: "enterprise"|"vivan"|"platform",
 *     persona_urn?: string                        // required when tenant_type === "vivan"
 *   }
 *   Response:
 *     200 {
 *       ap_ref,
 *       tier_0: { verdict, matched_rules, reasoning, confidence },
 *       tier_1: { verdict, matched_rules, reasoning, confidence },
 *       overall: "ALLOWED" | "DENIED_CONSTITUTIONAL" | "OUT_OF_SCOPE" | "AMBIGUOUS",
 *       constitution_version,
 *       timestamp,
 *       requester,
 *       escalation_required?: boolean             // set when overall === "AMBIGUOUS"
 *     }
 *     400 INVALID_REQUEST  — missing required fields (ap_ref, action, tenant_urn, tenant_type, or persona_urn for vivan)
 *     503 CONSTITUTION_UNAVAILABLE — Graph read failed at Tier 0
 *
 * Tier 0 UNCONSTITUTIONAL produces `overall: "DENIED_CONSTITUTIONAL"` immediately.
 * Nomos (relay g7c-3) MUST NOT emit a PEM for this outcome — it is absolute denial.
 */

import { Router } from 'express';
import { requireAuthorizedSource } from '../../lib/access-control.js';

const VALID_TENANT_TYPES = new Set(['enterprise', 'vivan', 'platform']);

function aggregate(tier0Verdict, tier1Verdict) {
  if (tier0Verdict === 'UNCONSTITUTIONAL') return 'DENIED_CONSTITUTIONAL';
  // Tier 0 = CONSTITUTIONAL or INDETERMINATE → consult Tier 1
  if (tier1Verdict === 'OUT_OF_SCOPE') return 'OUT_OF_SCOPE';
  if (tier1Verdict === 'AMBIGUOUS') return 'AMBIGUOUS';
  if (tier0Verdict === 'INDETERMINATE') return 'AMBIGUOUS'; // ambiguous constitutional check also escalates
  return 'ALLOWED';
}

/**
 * @param {object} deps
 * @param {object} deps.governanceLoaders — {loadConstitution, loadEntityBor, loadStatuteEffective}
 * @param {object} deps.determinationStore
 * @param {function} deps.matchConstitutional
 * @param {function} deps.matchScope
 */
export function createScopeRoutes({ governanceLoaders, determinationStore, matchConstitutional, matchScope }) {
  const router = Router();

  router.post('/scope-query', requireAuthorizedSource, async (req, res) => {
    const {
      ap_ref,
      action,
      targets = [],
      intent = '',
      tenant_urn,
      tenant_type,
      persona_urn,
    } = req.body || {};

    // ── Request validation (strict — no default-through per MP-17 guardrail) ──
    if (!ap_ref || !action) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'ap_ref and action are required',
      });
    }
    if (!tenant_urn || typeof tenant_urn !== 'string') {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'tenant_urn is required (MP-17 contract — Thalamus populates at AP drafting)',
      });
    }
    if (!tenant_type || !VALID_TENANT_TYPES.has(tenant_type)) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: `tenant_type is required and must be one of ${[...VALID_TENANT_TYPES].join(', ')}`,
      });
    }
    if (tenant_type === 'vivan' && (!persona_urn || typeof persona_urn !== 'string')) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'persona_urn is required when tenant_type is "vivan"',
      });
    }

    // ── Tier 0: Constitutional check (always runs) ──
    let constitution;
    try {
      constitution = await governanceLoaders.loadConstitution();
    } catch (err) {
      return res.status(503).json({
        error: 'CONSTITUTION_UNAVAILABLE',
        message: 'Constitution could not be loaded from Graph',
        detail: err.message,
      });
    }
    if (!constitution) {
      return res.status(503).json({
        error: 'CONSTITUTION_UNAVAILABLE',
        message: 'Constitution concept not present in Graph',
      });
    }

    const tier0 = await matchConstitutional({
      action,
      targets,
      intent,
      constitution,
    });

    // UNCONSTITUTIONAL is absolute per binding decision #34 — short-circuit.
    if (tier0.verdict === 'UNCONSTITUTIONAL') {
      const determination = {
        ap_ref,
        tier_0: tier0,
        tier_1: { verdict: 'N/A', matched_rules: [], reasoning: 'Short-circuited by Tier 0 UNCONSTITUTIONAL.', confidence: 0 },
        overall: 'DENIED_CONSTITUTIONAL',
        constitution_version: constitution.version,
        tenant_urn,
        tenant_type,
        timestamp: new Date().toISOString(),
        requester: req.sourceOrgan,
      };
      determinationStore.add(determination);
      return res.json(determination);
    }

    // ── Tier 1: entity / vivan / platform scope check ──
    let tier1;
    try {
      if (tenant_type === 'platform') {
        // Platform-scoped APMs have no entity governance above the Constitution.
        // Tier 1 auto-passes; Tier 0 verdict carries through aggregation.
        tier1 = {
          verdict: 'IN_SCOPE',
          matched_rules: [],
          reasoning: 'Tenant type is platform — no entity governance above Constitution.',
          confidence: 1,
        };
      } else if (tenant_type === 'enterprise') {
        const entityBor = await governanceLoaders.loadEntityBor(tenant_urn);
        tier1 = await matchScope({ action, targets, intent, governance: entityBor });
      } else {
        // tenant_type === 'vivan'
        const effective = await governanceLoaders.loadStatuteEffective(persona_urn);
        // Convert resolved cascade to the BoR doc shape the matcher expects.
        // layersApplied order is general→specific; the last layer's payload wins per mergeChain,
        // but the matcher evaluates the EFFECTIVE flat map, not each layer. We present the
        // merged constraints as a single pseudo-article so the matcher can reason textually.
        const effectiveDoc = effectiveGovernanceToBorDocShape(effective);
        tier1 = await matchScope({ action, targets, intent, governance: effectiveDoc });
      }
    } catch (err) {
      return res.status(503).json({
        error: 'TIER1_GOVERNANCE_UNAVAILABLE',
        message: 'Tier 1 governance document could not be resolved',
        detail: err.message,
      });
    }

    const overall = aggregate(tier0.verdict, tier1.verdict);
    const determination = {
      ap_ref,
      tier_0: tier0,
      tier_1: tier1,
      overall,
      constitution_version: constitution.version,
      tenant_urn,
      tenant_type,
      timestamp: new Date().toISOString(),
      requester: req.sourceOrgan,
    };
    if (overall === 'AMBIGUOUS') {
      determination.escalation_required = true;
    }
    determinationStore.add(determination);
    return res.json(determination);
  });

  router.get('/determinations', async (req, res) => {
    const { ap_ref, determination, since, limit } = req.query;
    const result = determinationStore.query({
      ap_ref,
      determination,
      since,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    res.json(result);
  });

  return router;
}

/**
 * Adapter: resolved statute cascade → BoR doc shape expected by matchScope.
 *
 * The cascade produces a flat effective-governance field map plus layer metadata.
 * The clause-matcher expects articles/clauses. We render the layered cascade as
 * pseudo-articles, one per applied layer, with the layer's contributing constraints
 * as textual content. This preserves the clause-matcher's existing LLM contract
 * while giving it the cascade's structure.
 */
export function effectiveGovernanceToBorDocShape(cascade) {
  if (!cascade) {
    return null;
  }
  const { effectiveGovernance = {}, layersApplied = [], constitutionFieldsLocked = [] } = cascade;
  const layerArticles = layersApplied.map((l) => ({
    id: l.layer,
    title: `Layer: ${l.layer}`,
    clauses: [],
    text: `URN: ${l.urn}`,
  }));
  const effectiveText = Object.keys(effectiveGovernance).length === 0
    ? '(no effective constraints — Vivan falls directly under Constitution)'
    : Object.entries(effectiveGovernance)
      .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}${constitutionFieldsLocked.includes(k) ? ' [constitutional-lock]' : ''}`)
      .join('\n');
  layerArticles.push({
    id: 'effective',
    title: 'Effective Governance (merged)',
    clauses: [],
    text: effectiveText,
  });
  return {
    version: `cascade:${layersApplied.map((l) => l.layer).join('>')}`,
    articles: layerArticles,
    clauseCount: 0,
    raw: layerArticles.map((a) => `## ${a.title}\n${a.text}`).join('\n\n'),
    constraints: effectiveGovernance,
    constitutionFieldsLocked,
  };
}
