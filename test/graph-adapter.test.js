import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerBorVersion, getLatestBorVersion, verifyBorHash } from '../lib/graph-adapter.js';

const GRAPH_URL = 'http://127.0.0.1:4020';

// Mock fetch for isolated unit tests
const originalFetch = globalThis.fetch;
let fetchCalls = [];
let fetchResponse = null;

function mockFetch(url, opts) {
  fetchCalls.push({ url, opts });
  return Promise.resolve(fetchResponse);
}

describe('Graph adapter', () => {
  beforeEach(() => {
    fetchCalls = [];
    fetchResponse = { ok: true, json: () => Promise.resolve({}) };
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('registerBorVersion', () => {
    it('POSTs concept to Graph /concepts', async () => {
      fetchResponse = { ok: true, json: () => Promise.resolve({}) };
      const urn = await registerBorVersion(GRAPH_URL, {
        version: '1.0.0', hash: 'abc123def456', clauseCount: 12,
      });
      assert.equal(urn, 'urn:graphheight:bor:1.0.0');
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, `${GRAPH_URL}/concepts`);
      const body = JSON.parse(fetchCalls[0].opts.body);
      assert.equal(body.type, 'bor_version');
      assert.equal(body.data.hash, 'abc123def456');
      assert.equal(body.data.clause_count, 12);
    });

    it('throws on Graph HTTP failure', async () => {
      fetchResponse = { ok: false, status: 500 };
      await assert.rejects(
        () => registerBorVersion(GRAPH_URL, { version: '1.0.0', hash: 'x', clauseCount: 0 }),
        /Graph insertConcept failed: 500/
      );
    });
  });

  describe('getLatestBorVersion', () => {
    it('returns latest version from Graph', async () => {
      fetchResponse = {
        ok: true,
        json: () => Promise.resolve({
          concepts: [{
            urn: 'urn:graphheight:bor:1.0.0',
            data: { version: '1.0.0', hash: 'abc', effective_since: '2026-04-09T00:00:00Z' },
          }],
        }),
      };
      const result = await getLatestBorVersion(GRAPH_URL);
      assert.equal(result.version, '1.0.0');
      assert.equal(result.hash, 'abc');
    });

    it('returns null when no versions registered', async () => {
      fetchResponse = { ok: true, json: () => Promise.resolve({ concepts: [] }) };
      assert.equal(await getLatestBorVersion(GRAPH_URL), null);
    });

    it('returns null on Graph failure (fail-open for reads)', async () => {
      fetchResponse = { ok: false, status: 500 };
      assert.equal(await getLatestBorVersion(GRAPH_URL), null);
    });
  });

  describe('verifyBorHash', () => {
    it('verified:true when hashes match', async () => {
      fetchResponse = {
        ok: true,
        json: () => Promise.resolve({
          concepts: [{ urn: 'urn:graphheight:bor:1.0.0', data: { version: '1.0.0', hash: 'match' } }],
        }),
      };
      const result = await verifyBorHash(GRAPH_URL, 'match');
      assert.equal(result.verified, true);
      assert.equal(result.mismatch, false);
    });

    it('mismatch:true when hashes differ', async () => {
      fetchResponse = {
        ok: true,
        json: () => Promise.resolve({
          concepts: [{ urn: 'urn:graphheight:bor:1.0.0', data: { version: '1.0.0', hash: 'old' } }],
        }),
      };
      const result = await verifyBorHash(GRAPH_URL, 'new');
      assert.equal(result.verified, false);
      assert.equal(result.mismatch, true);
    });

    it('verified:false + registered:null when nothing registered', async () => {
      fetchResponse = { ok: true, json: () => Promise.resolve({ concepts: [] }) };
      const result = await verifyBorHash(GRAPH_URL, 'any');
      assert.equal(result.verified, false);
      assert.equal(result.registered, null);
    });
  });
});
