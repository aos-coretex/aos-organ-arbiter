/**
 * BoR version route — current document version and integrity hash.
 *
 * GET /bor/version
 */

import { Router } from 'express';
import { loadBoR } from '../../lib/bor-loader.js';

/**
 * @param {object} deps
 * @param {object} deps.config
 */
export function createBorRoutes({ config }) {
  const router = Router();

  /**
   * GET /bor/version
   *
   * Returns current BoR version, hash, clause count, and last amendment date.
   * Used by Nomos and Senate to verify they reference the correct BoR version.
   * No access control — version info is non-sensitive.
   */
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

  return router;
}
