/**
 * Graph organ adapter — BoR version hash registration and verification.
 *
 * Graph (#40) on port 4020 (AOS) / 3920 (SAAS).
 *
 * Arbiter stores BoR version hashes as concepts in Graph:
 *   URN:  urn:graphheight:bor:<version>
 *   Type: bor_version
 *   Data: { version, hash, effective_since, clause_count, registered_by }
 *
 * Verification flow at boot and on `bor_updated`:
 *   1. Load BoR document → compute current SHA-256 hash + extract version
 *   2. Query Graph for the concept at `urn:graphheight:bor:<version>`
 *   3. If missing → register (first registration of this version)
 *   4. If present → compare hashes; mismatch raises DEGRADED mode
 *
 * Both the write path (`registerBorVersion`) and the read path
 * (`getBorVersion` / `verifyBorHash`) delegate to the shared type-agnostic
 * `graph-client.js` in `@coretex/organ-boot`. The client composes canonical
 * post-a7u-5 envelopes (`{ urn, data: { type, ...fields } }`) and attaches
 * `X-Organ-Name: Arbiter`. No exemption header — Arbiter is a governance
 * reader/writer, not an infrastructure-exempt actor.
 *
 * Fail-open semantics: read-path errors (network, 5xx, schema) degrade to
 * `registered: null`, which the boot path treats as "first-boot, register".
 * This prevents Graph unavailability from blocking Arbiter startup.
 *
 * Read-path migrated in C2A `c2a-arbiter-08-bor-read-path-migration`
 * (2026-04-14). Semantic note: pre-migration, `getLatestBorVersion` queried
 * `GET /concepts?type=bor_version&limit=1&sort=desc` — a route Graph does
 * not expose (it 404s today, silently returning null). Post-migration,
 * `getBorVersion(graphUrl, version)` looks up the specific `bor_version`
 * concept by its deterministic URN. This is a subtle semantic shift: two
 * Arbiters running different BoR versions now each register their own
 * URN-distinct concept and coexist, rather than the running one forcing
 * DEGRADED mode when its hash differs from whatever was "latest". The boot
 * sequence was already URN-idempotent on the write side, so the new read
 * semantics match intent.
 *
 * In target architecture, Graphheight 511 mints URNs and 311 caches hashes.
 * This adapter's external API will not change — only the internal routing.
 */

import {
  createGraphClient,
  GraphUnreachableError,
} from '@coretex/organ-boot/graph-client';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// Per-graphUrl memoized client so existing callers that pass graphUrl per
// call do not need to change. Mirrors the Nomos/Senate/Cerberus pattern.
const clientCache = new Map();

function clientFor(graphUrl) {
  let client = clientCache.get(graphUrl);
  if (!client) {
    client = createGraphClient({ baseUrl: graphUrl, organName: 'Arbiter' });
    clientCache.set(graphUrl, client);
  }
  return client;
}

/**
 * Register a BoR version hash in Graph.
 * @param {string} graphUrl - Graph organ base URL
 * @param {{ version: string, hash: string, clauseCount: number }} borInfo
 * @returns {Promise<string>} registered URN
 * @throws {Error} on Graph failure (non-recoverable — Arbiter cannot operate without registered hash)
 */
export async function registerBorVersion(graphUrl, borInfo) {
  const urn = `urn:graphheight:bor:${borInfo.version}`;
  const client = clientFor(graphUrl);

  try {
    await client.insertConcept('bor_version', urn, {
      version: borInfo.version,
      hash: borInfo.hash,
      clause_count: borInfo.clauseCount,
      effective_since: new Date().toISOString(),
      registered_by: 'Arbiter',
    });
    log('bor_version_registered', { urn, hash: borInfo.hash, clause_count: borInfo.clauseCount });
    return urn;
  } catch (error) {
    log('bor_version_registration_failed', { error: error.message, urn });
    throw error;
  }
}

/**
 * Get the registered concept for a specific BoR version.
 *
 * Fail-open: returns `null` on any error (network, 5xx, schema) so the boot
 * path treats Graph unavailability as "first-boot, register".
 *
 * @param {string} graphUrl
 * @param {string} version - BoR version string (e.g. "1.0.0-seed")
 * @returns {Promise<{ urn: string, version: string, hash: string, effective_since: string } | null>}
 */
export async function getBorVersion(graphUrl, version) {
  const urn = `urn:graphheight:bor:${version}`;
  const client = clientFor(graphUrl);

  try {
    const concept = await client.queryConcept(urn);
    if (concept === null) return null;
    return {
      urn: concept.urn,
      version: concept.data?.version,
      hash: concept.data?.hash,
      effective_since: concept.data?.effective_since,
    };
  } catch (error) {
    const statusOrNetwork = error?.status != null
      ? String(error.status)
      : (error instanceof GraphUnreachableError ? 'network' : error?.message);
    log('bor_version_query_failed', { urn, error: error.message, status: statusOrNetwork });
    return null;
  }
}

/**
 * Verify the BoR document hash against the Graph-registered version.
 *
 * Queries the specific `urn:graphheight:bor:<version>` concept. If absent,
 * returns `{ registered: null }` (boot path interprets as first-registration).
 * If present, compares registered hash against the computed hash.
 *
 * @param {string} graphUrl
 * @param {string} version - BoR version string from the loaded document
 * @param {string} currentHash - SHA-256 hash of the current BoR file content
 * @returns {Promise<{ verified: boolean, registered: object | null, mismatch: boolean }>}
 */
export async function verifyBorHash(graphUrl, version, currentHash) {
  const registered = await getBorVersion(graphUrl, version);

  if (!registered) {
    return { verified: false, registered: null, mismatch: false };
  }

  const mismatch = registered.hash !== currentHash;

  if (mismatch) {
    log('bor_hash_mismatch', {
      expected: registered.hash,
      actual: currentHash,
      registered_version: registered.version,
    });
  }

  return { verified: !mismatch, registered, mismatch };
}
