/**
 * POST /constitutional-check — MP-17 Tier 0 fast path.
 *
 * Consumed by Nomos (relay g7c-3) as the first step of three-tier adjudication.
 * UNCONSTITUTIONAL outcomes are absolute: caller must Deny the action immediately
 * and MUST NOT emit a PEM (MP-17 binding decision #34).
 *
 * Request: { action: string, targets?: string[], context?: object }
 * Response:
 *   200 { verdict: "CONSTITUTIONAL"|"UNCONSTITUTIONAL"|"INDETERMINATE",
 *         matched_rules: string[],
 *         constitution_version: string }
 *   400 INVALID_REQUEST when required fields absent
 *   503 CONSTITUTION_UNAVAILABLE when Graph read fails
 */

import { Router } from 'express';
import { requireAuthorizedSource } from '../../lib/access-control.js';

export function createConstitutionalCheckRoutes({ governanceLoaders, matchConstitutional }) {
  const router = Router();

  router.post('/constitutional-check', requireAuthorizedSource, async (req, res) => {
    const { action, targets = [], context = {} } = req.body || {};

    if (!action || typeof action !== 'string') {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'action is required',
      });
    }

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

    const result = await matchConstitutional({
      action,
      targets,
      intent: context.intent || '',
      constitution,
    });

    return res.json({
      verdict: result.verdict,
      matched_rules: result.matched_rules,
      constitution_version: constitution.version,
      confidence: result.confidence,
      reasoning: result.reasoning,
      timestamp: new Date().toISOString(),
      requester: req.sourceOrgan,
    });
  });

  return router;
}
