/**
 * Scope query routes — the core Arbiter API.
 *
 * POST /scope-query  — evaluate an action against the BoR
 * GET /determinations — audit trail of past determinations
 */

import { Router } from 'express';
import { requireAuthorizedSource } from '../../lib/access-control.js';
import { loadBoR } from '../../lib/bor-loader.js';
import { verifyBorHash } from '../../lib/graph-adapter.js';

/**
 * @param {object} deps
 * @param {object} deps.config — server config
 * @param {object} deps.determinationStore — in-memory determination store
 * @param {function} deps.evaluateScope — clause matching function (stub until relay a8j-3)
 */
export function createScopeRoutes({ config, determinationStore, evaluateScope }) {
  const router = Router();

  /**
   * POST /scope-query
   *
   * Input: { ap_ref, action, targets, intent, bor_version? }
   * Output: { determination, cited_clauses, bor_version, bor_hash, confidence, reasoning, ap_ref, timestamp }
   *
   * Flow:
   *   1. Validate request (ap_ref and action required)
   *   2. Load BoR document
   *   3. Verify hash against Graph
   *   4. Run clause matching (relay a8j-3 — stubbed as AMBIGUOUS here)
   *   5. Record determination
   *   6. Return result
   */
  router.post('/scope-query', requireAuthorizedSource, async (req, res) => {
    const { ap_ref, action, targets = [], intent = '', bor_version } = req.body;

    // Validate required fields
    if (!ap_ref || !action) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'ap_ref and action are required',
      });
    }

    try {
      // Load BoR
      let bor;
      try {
        bor = await loadBoR(config.borPath);
      } catch (err) {
        return res.status(503).json({
          error: 'BOR_DOCUMENT_UNAVAILABLE',
          message: 'Bill of Rights document could not be loaded',
          detail: err.code === 'ENOENT' ? 'File not found' : err.message,
          determination: 'AMBIGUOUS',
          escalation_required: true,
        });
      }

      // Verify hash against Graph
      const verification = await verifyBorHash(config.graphUrl, bor.hash);
      if (verification.mismatch) {
        return res.status(409).json({
          error: 'BOR_VERSION_MISMATCH',
          message: 'BoR document hash does not match registered version',
          expected_hash: verification.registered?.hash,
          actual_hash: bor.hash,
        });
      }

      // Version check (if specific version requested)
      if (bor_version && bor_version !== bor.version) {
        return res.status(409).json({
          error: 'BOR_VERSION_MISMATCH',
          message: `Requested version ${bor_version} does not match current ${bor.version}`,
        });
      }

      // Run determination (stub — relay a8j-3 provides real implementation)
      const result = await evaluateScope({
        action,
        targets,
        intent,
        bor,
      });

      // Build determination record
      const determination = {
        ap_ref,
        determination: result.determination,
        cited_clauses: result.cited_clauses || [],
        bor_version: bor.version,
        bor_hash: bor.hash,
        confidence: result.confidence || 0,
        reasoning: result.reasoning || '',
        timestamp: new Date().toISOString(),
        requester: req.sourceOrgan,
      };

      // Add escalation flag for AMBIGUOUS
      if (determination.determination === 'AMBIGUOUS') {
        determination.escalation_required = true;
      }

      // Record
      determinationStore.add(determination);

      res.json(determination);
    } catch (err) {
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  /**
   * GET /determinations
   *
   * Query params: ap_ref, determination, since (ISO8601), limit (default 50)
   */
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
