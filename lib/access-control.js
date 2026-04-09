/**
 * Access control for Arbiter — restricts queries to authorized organs.
 *
 * Per architectural conclusions (Section 10):
 *   - Only Nomos and the Human Principal may query Arbiter
 *   - All other organs are rejected with UNAUTHORIZED_QUERIER
 *
 * Access is validated via:
 *   1. HTTP header `X-Source-Organ` (for HTTP requests)
 *   2. `source_organ` field in Spine message envelopes (for directed messages)
 *
 * In target architecture, Phi session tokens provide cryptographic
 * identity verification. In interim, header-based validation.
 */

const AUTHORIZED_SOURCES = new Set(['Nomos', 'Human_Principal', 'human_principal']);

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * Express middleware — validates X-Source-Organ header.
 * Rejects unauthorized callers with 403 and UNAUTHORIZED_QUERIER.
 */
export function requireAuthorizedSource(req, res, next) {
  const source = req.headers['x-source-organ'] || req.body?.requester;

  if (!source || !AUTHORIZED_SOURCES.has(source)) {
    log('unauthorized_querier', {
      source: source || 'unknown',
      method: req.method,
      path: req.path,
      ip: req.ip,
    });
    return res.status(403).json({
      error: 'UNAUTHORIZED_QUERIER',
      message: 'Only Nomos and the Human Principal may query Arbiter',
      source: source || 'unknown',
    });
  }

  req.sourceOrgan = source;
  next();
}

/**
 * Validate source organ from a Spine message envelope.
 * @param {object} envelope - Spine message envelope
 * @returns {{ authorized: boolean, source: string }}
 */
export function validateSpineSource(envelope) {
  const source = envelope.source_organ || envelope.payload?.source_organ;
  const authorized = source && AUTHORIZED_SOURCES.has(source);

  if (!authorized) {
    log('unauthorized_spine_querier', { source: source || 'unknown' });
  }

  return { authorized: !!authorized, source: source || 'unknown' };
}
