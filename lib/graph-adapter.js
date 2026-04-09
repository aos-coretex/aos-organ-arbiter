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
 * Verification flow at every scope query:
 *   1. Load BoR document → compute current SHA-256 hash
 *   2. Query Graph for latest registered bor_version concept
 *   3. Compare hashes — mismatch raises BOR_VERSION_MISMATCH
 *
 * In target architecture, Graphheight 511 mints URNs and 311 caches hashes.
 * This adapter's external API will not change — only the internal routing.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
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

  try {
    const response = await fetch(`${graphUrl}/concepts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn,
        type: 'bor_version',
        data: {
          version: borInfo.version,
          hash: borInfo.hash,
          clause_count: borInfo.clauseCount,
          effective_since: new Date().toISOString(),
          registered_by: 'Arbiter',
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Graph insertConcept failed: ${response.status}`);
    }

    log('bor_version_registered', { urn, hash: borInfo.hash, clause_count: borInfo.clauseCount });
    return urn;
  } catch (error) {
    log('bor_version_registration_failed', { error: error.message, urn });
    throw error;
  }
}

/**
 * Get the latest registered BoR version from Graph.
 * @param {string} graphUrl
 * @returns {Promise<{ urn: string, version: string, hash: string, effective_since: string } | null>}
 */
export async function getLatestBorVersion(graphUrl) {
  try {
    const response = await fetch(
      `${graphUrl}/concepts?type=bor_version&limit=1&sort=desc`
    );

    if (!response.ok) {
      throw new Error(`Graph query failed: ${response.status}`);
    }

    const result = await response.json();
    const concepts = result.concepts || result.results || [];
    if (concepts.length === 0) return null;

    const concept = concepts[0];
    return {
      urn: concept.urn,
      version: concept.data?.version,
      hash: concept.data?.hash,
      effective_since: concept.data?.effective_since,
    };
  } catch (error) {
    log('bor_version_query_failed', { error: error.message });
    return null;
  }
}

/**
 * Verify the BoR document hash against the Graph-registered version.
 * @param {string} graphUrl
 * @param {string} currentHash - SHA-256 hash of the current BoR file content
 * @returns {Promise<{ verified: boolean, registered: object | null, mismatch: boolean }>}
 */
export async function verifyBorHash(graphUrl, currentHash) {
  const registered = await getLatestBorVersion(graphUrl);

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
