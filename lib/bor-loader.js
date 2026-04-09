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
