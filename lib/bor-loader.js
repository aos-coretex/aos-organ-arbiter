/**
 * BoR document loader — reads, parses, and hashes the Bill of Rights.
 *
 * Responsibilities:
 *   - Read BoR markdown from vault path
 *   - Parse article structure (## Article I, ## Article II, etc.)
 *   - Extract clauses within articles (### Clause I.1, etc.)
 *   - Compute SHA-256 hash of the raw file content
 *   - Return structured representation for clause matching
 *
 * The BoR is NEVER embedded as prompt DNA. It is read at query time
 * and referenced by version/hash. The LLM receives clause text only
 * during an active scope query.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  constitutionUrn,
  entityBorUrn,
} from '@coretex/organ-boot/governance-urn';
import { resolveCascade } from '@coretex/organ-boot/statute-cascade';

/**
 * @typedef {{ id: string, title: string, text: string }} Clause
 * @typedef {{ id: string, title: string, clauses: Clause[], text: string }} Article
 * @typedef {{ version: string, hash: string, articles: Article[], raw: string, clauseCount: number }} BoRDocument
 */

/**
 * Load and parse the BoR document from disk.
 * @param {string} filePath - absolute path to bill-of-rights.md
 * @returns {Promise<BoRDocument>}
 * @throws {Error} if file cannot be read (ENOENT → BOR_DOCUMENT_UNAVAILABLE)
 */
export async function loadBoR(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  const hash = computeHash(raw);
  const version = extractVersion(raw);
  const articles = parseArticles(raw);
  const clauseCount = articles.reduce((sum, a) => sum + a.clauses.length, 0);

  return { version, hash, articles, raw, clauseCount };
}

/**
 * Compute SHA-256 hash of content.
 * @param {string} content
 * @returns {string} hex-encoded hash
 */
export function computeHash(content) {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Extract version string from frontmatter or header.
 * @param {string} raw - raw markdown content
 * @returns {string} version string or 'unknown'
 */
function extractVersion(raw) {
  // Try YAML frontmatter
  const fmMatch = raw.match(/^---\n[\s\S]*?version:\s*(.+)\n[\s\S]*?---/);
  if (fmMatch) return fmMatch[1].trim();

  // Try inline header
  const headerMatch = raw.match(/>\s*\*\*Version:\*\*\s*(.+)/);
  if (headerMatch) return headerMatch[1].trim();

  return 'unknown';
}

/**
 * Parse articles and clauses from BoR markdown.
 *
 * Articles:  ## Article <roman> — <title>
 * Clauses:   ### Clause <id> — <title>
 *
 * @param {string} raw - raw markdown content
 * @returns {Article[]}
 */
export function parseArticles(raw) {
  const articles = [];
  const lines = raw.split('\n');

  let currentArticle = null;
  let currentClause = null;
  let buffer = [];

  for (const line of lines) {
    const articleMatch = line.match(/^## (Article\s+([IVXLCDM]+))\s*—?\s*(.*)/);
    const clauseMatch = line.match(/^### (Clause\s+([\w.]+))\s*—?\s*(.*)/);

    if (articleMatch) {
      // Flush previous clause
      if (currentClause) {
        currentClause.text = buffer.join('\n').trim();
        buffer = [];
      }
      // Flush previous article
      if (currentArticle) {
        if (!currentClause && buffer.length) {
          currentArticle.text = buffer.join('\n').trim();
        }
        articles.push(currentArticle);
        buffer = [];
      }
      currentArticle = {
        id: articleMatch[2],
        title: articleMatch[3].trim(),
        clauses: [],
        text: '',
      };
      currentClause = null;
    } else if (clauseMatch && currentArticle) {
      // Flush previous clause
      if (currentClause) {
        currentClause.text = buffer.join('\n').trim();
        buffer = [];
      } else if (buffer.length && currentArticle) {
        currentArticle.text = buffer.join('\n').trim();
        buffer = [];
      }
      currentClause = {
        id: clauseMatch[2],
        title: clauseMatch[3].trim(),
        text: '',
      };
      currentArticle.clauses.push(currentClause);
    } else {
      buffer.push(line);
    }
  }

  // Flush final state
  if (currentClause) {
    currentClause.text = buffer.join('\n').trim();
  } else if (currentArticle && buffer.length) {
    currentArticle.text = buffer.join('\n').trim();
  }
  if (currentArticle) {
    articles.push(currentArticle);
  }

  return articles;
}

// ────────────────────────────────────────────────────────────────────────────
// Graph-backed governance loaders (MP-17 relay g7c-2).
//
// Constitution, entity BoR, and statute cascade live in Graph as concepts.
// Arbiter reads them per scope query, with a short-TTL in-process cache so
// hot-path queries do not storm Graph. Cache TTL is intentionally short —
// Senate (g7c-4) publishes via Spine broadcast, and a stale window of ≤60s
// is acceptable for Phase-1 governance throughput.
//
// Adapter `conceptToBorDocShape` converts a Graph governance concept into
// the {version, articles, clauses, raw} shape the existing clause-matcher
// expects. Sections in the Graph concept become articles; each section's
// textual content becomes the article body. Scaffold concepts with
// REQUIRES_HUMAN_AUTHORSHIP:true produce articles whose text contains the
// placeholder marker — clause-matcher's existing `[To be defined]` detection
// converts these to AMBIGUOUS / INDETERMINATE outcomes without special-case
// code in this loader.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert a Graph governance concept ({urn, data:{type, version, sections, constraints?}})
 * into the {version, articles, clauses, raw, urn, constraints} shape callers expect.
 *
 * @param {object} concept — {urn, data, created_at}
 * @returns {object}
 */
export function conceptToBorDocShape(concept) {
  if (!concept || !concept.data) return null;
  const { urn, data } = concept;
  const sections = (data && typeof data.sections === 'object' && data.sections !== null) ? data.sections : {};
  const articles = Object.entries(sections).map(([key, value]) => {
    const content = value && typeof value === 'object' ? value.content : value;
    const text = Array.isArray(content)
      ? content.map(String).join('\n')
      : (typeof content === 'string' ? content : JSON.stringify(content ?? ''));
    return {
      id: key,
      title: key.replace(/_/g, ' '),
      clauses: [],
      text,
    };
  });
  const rawParts = articles.map((a) => `## ${a.title}\n${a.text}`);
  const clauseCount = articles.reduce((sum, a) => sum + a.clauses.length, 0);
  return {
    urn,
    version: data.version || 'unknown',
    articles,
    clauseCount,
    raw: rawParts.join('\n\n'),
    constraints: (data && typeof data.constraints === 'object' && data.constraints !== null) ? data.constraints : {},
    scaffold: !!data.REQUIRES_HUMAN_AUTHORSHIP,
  };
}

/**
 * Factory: create a set of Graph-backed governance loaders with a short-TTL
 * in-process cache. Each returned loader is an async function; the cache is
 * shared across them and keyed by URN.
 *
 * The caller supplies a graphClient (typically from @coretex/organ-boot/graph-client)
 * and optional TTL + clock. Dependency-injectable; production wires the real
 * graph client, tests inject a mock.
 *
 * @param {object} opts
 * @param {object} opts.graphClient — must expose queryConcept(urn) + queryBindings(filters)
 * @param {number} [opts.ttlMs=60000]
 * @param {function} [opts.now] — injectable clock, defaults to Date.now
 * @returns {{ loadConstitution, loadEntityBor, loadStatuteEffective, invalidate, cacheSize }}
 */
export function createGovernanceLoaders({ graphClient, ttlMs = 60_000, now = Date.now } = {}) {
  if (!graphClient || typeof graphClient.queryConcept !== 'function') {
    throw new TypeError('createGovernanceLoaders: graphClient with queryConcept required');
  }

  const cache = new Map(); // urn -> {expiresAt, value}

  function getCached(urn) {
    const entry = cache.get(urn);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      cache.delete(urn);
      return undefined;
    }
    return entry.value;
  }

  function setCached(urn, value) {
    cache.set(urn, { expiresAt: now() + ttlMs, value });
  }

  async function loadConstitution() {
    const urn = constitutionUrn();
    const cached = getCached(urn);
    if (cached !== undefined) return cached;
    const concept = await graphClient.queryConcept(urn);
    const shaped = concept ? conceptToBorDocShape(concept) : null;
    setCached(urn, shaped);
    return shaped;
  }

  async function loadEntityBor(tenantUrn) {
    if (typeof tenantUrn !== 'string') {
      throw new TypeError('loadEntityBor: tenantUrn string required');
    }
    const urn = entityBorUrn(tenantUrn);
    const cached = getCached(urn);
    if (cached !== undefined) return cached;
    const concept = await graphClient.queryConcept(urn);
    const shaped = concept ? conceptToBorDocShape(concept) : null;
    setCached(urn, shaped);
    return shaped;
  }

  async function loadStatuteEffective(personaUrn) {
    if (typeof personaUrn !== 'string') {
      throw new TypeError('loadStatuteEffective: personaUrn string required');
    }
    // Cascade resolution is a computed view over multiple Graph reads; cache
    // the composed result to avoid re-walking on every query. Cache key uses
    // a scheme-isolated prefix so it doesn't collide with concept URN keys.
    const cacheKey = `cascade::${personaUrn}`;
    const cached = getCached(cacheKey);
    if (cached !== undefined) return cached;
    const result = await resolveCascade({ personaUrn, graphClient });
    setCached(cacheKey, result);
    return result;
  }

  function invalidate(urn) {
    if (urn == null) {
      cache.clear();
      return;
    }
    cache.delete(urn);
  }

  return {
    loadConstitution,
    loadEntityBor,
    loadStatuteEffective,
    invalidate,
    get cacheSize() { return cache.size; },
  };
}
