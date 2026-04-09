import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBoR, computeHash, parseArticles } from '../lib/bor-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'test-bor.md');

describe('computeHash', () => {
  it('returns consistent SHA-256 hex string', () => {
    const hash = computeHash('hello world');
    assert.equal(hash.length, 64);
    assert.equal(hash, computeHash('hello world'));
  });

  it('produces different hashes for different content', () => {
    assert.notEqual(computeHash('version 1'), computeHash('version 2'));
  });
});

describe('parseArticles', () => {
  it('extracts all 6 articles from test fixture', async () => {
    const raw = await readFile(fixturePath, 'utf-8');
    const articles = parseArticles(raw);
    assert.equal(articles.length, 6);
  });

  it('extracts article IDs as roman numerals', async () => {
    const raw = await readFile(fixturePath, 'utf-8');
    const articles = parseArticles(raw);
    assert.deepEqual(articles.map(a => a.id), ['I', 'II', 'III', 'IV', 'V', 'VI']);
  });

  it('extracts article titles', async () => {
    const raw = await readFile(fixturePath, 'utf-8');
    const articles = parseArticles(raw);
    assert.equal(articles[0].title, 'Scope of Enterprise');
    assert.equal(articles[1].title, 'Prohibited Activities');
  });

  it('extracts clauses within articles', async () => {
    const raw = await readFile(fixturePath, 'utf-8');
    const articles = parseArticles(raw);
    assert.equal(articles[0].clauses.length, 2);  // Article I: 2 clauses
    assert.equal(articles[0].clauses[0].id, 'I.1');
    assert.equal(articles[0].clauses[1].id, 'I.2');
  });

  it('extracts clause text content', async () => {
    const raw = await readFile(fixturePath, 'utf-8');
    const articles = parseArticles(raw);
    assert.ok(articles[0].clauses[0].text.includes('software development'));
  });

  it('handles articles with multiple clauses', async () => {
    const raw = await readFile(fixturePath, 'utf-8');
    const articles = parseArticles(raw);
    assert.equal(articles[1].clauses.length, 3);  // Article II: 3 clauses
  });

  it('returns empty array for content with no articles', () => {
    const articles = parseArticles('# Just a heading\nSome text');
    assert.equal(articles.length, 0);
  });
});

describe('loadBoR', () => {
  it('loads and parses the test fixture', async () => {
    const bor = await loadBoR(fixturePath);
    assert.equal(bor.version, 'test-1.0.0');
    assert.equal(bor.hash.length, 64);
    assert.equal(bor.articles.length, 6);
    assert.ok(bor.clauseCount > 0);
    assert.ok(bor.raw.length > 0);
  });

  it('hash is deterministic across loads', async () => {
    const bor1 = await loadBoR(fixturePath);
    const bor2 = await loadBoR(fixturePath);
    assert.equal(bor1.hash, bor2.hash);
  });

  it('throws ENOENT on missing file', async () => {
    await assert.rejects(
      () => loadBoR('/nonexistent/path.md'),
      { code: 'ENOENT' }
    );
  });

  it('counts total clauses across all articles', async () => {
    const bor = await loadBoR(fixturePath);
    // I:2 + II:3 + III:1 + IV:2 + V:2 + VI:2 = 12
    assert.equal(bor.clauseCount, 12);
  });
});
