/**
 * BoR routes — version metadata and raw document text.
 *
 *   GET /bor/version — light metadata (re-reads from disk)
 *   GET /bor/raw     — raw BoR text + metadata from in-memory state
 *
 * The raw endpoint is read-only constitutional context for strategic
 * organs (e.g. Cortex) that must know the BoR without ruling on scope.
 * Arbiter remains the single source of truth: Cortex calls this endpoint
 * instead of reading `bill-of-rights.md` directly.
 */

import { Router } from 'express';
import { loadBoR } from '../../lib/bor-loader.js';

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} [deps.borState] - In-memory BoR state populated at boot.
 *   Shape: { loaded, version, hash, raw, effectiveSince, loadedAt, ... }
 *   Optional for backward compatibility with tests that only exercise
 *   /bor/version. When absent or not loaded, /bor/raw returns 503.
 */
export function createBorRoutes({ config, borState }) {
  const router = Router();

  router.get('/bor/version', async (req, res) => {
    try {
      const bor = await loadBoR(config.borPath);
      res.json({
        version: bor.version,
        hash: bor.hash,
        clause_count: bor.clauseCount,
        article_count: bor.articles.length,
        last_loaded: new Date().toISOString(),
      });
    } catch (err) {
      res.status(503).json({
        error: 'BOR_DOCUMENT_UNAVAILABLE',
        message: 'Bill of Rights document could not be loaded',
      });
    }
  });

  router.get('/bor/raw', (req, res) => {
    if (!borState || !borState.loaded || typeof borState.raw !== 'string') {
      return res.status(503).json({ error: 'BOR_NOT_LOADED' });
    }
    res.json({
      version: borState.version,
      hash: borState.hash,
      raw_text: borState.raw,
      effective_since: borState.effectiveSince,
      loaded_at: borState.loadedAt,
    });
  });

  return router;
}
