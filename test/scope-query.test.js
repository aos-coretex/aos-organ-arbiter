import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createScopeRoutes } from '../server/routes/scope.js';
import { createBorRoutes } from '../server/routes/bor.js';
import { createDeterminationStore } from '../lib/determination-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'test-bor.md');

// Mock fetch for Graph adapter (verifyBorHash calls Graph)
const originalFetch = globalThis.fetch;

/**
 * Helper: make HTTP request to test server.
 */
function req(server, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const opts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// Stub evaluateScope
const stubEvaluateScope = async () => ({
  determination: 'AMBIGUOUS',
  cited_clauses: [],
  confidence: 0,
  reasoning: 'Stub — relay a8j-3 implements clause matching',
});

describe('Scope Query API', () => {
  let server, determinationStore;

  before(async () => {
    // Mock fetch: Graph verifyBorHash returns "no registered version" (no mismatch)
    globalThis.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ concepts: [] }),
    });

    determinationStore = createDeterminationStore();
    const app = express();
    app.use(express.json());

    const scopeRoutes = createScopeRoutes({
      config: { borPath: fixturePath, graphUrl: 'http://127.0.0.1:4020' },
      determinationStore,
      evaluateScope: stubEvaluateScope,
    });
    const borRoutes = createBorRoutes({
      config: { borPath: fixturePath },
    });

    app.use(scopeRoutes);
    app.use(borRoutes);

    server = await new Promise((resolve) => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (server) await new Promise(resolve => server.close(resolve));
  });

  describe('POST /scope-query', () => {
    it('returns 403 without X-Source-Organ header', async () => {
      const res = await req(server, 'POST', '/scope-query', { ap_ref: 'ap1', action: 'test' });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'UNAUTHORIZED_QUERIER');
    });

    it('returns 400 when ap_ref missing', async () => {
      const res = await req(server, 'POST', '/scope-query',
        { action: 'test' },
        { 'X-Source-Organ': 'Nomos' }
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'INVALID_REQUEST');
    });

    it('returns 400 when action missing', async () => {
      const res = await req(server, 'POST', '/scope-query',
        { ap_ref: 'ap1' },
        { 'X-Source-Organ': 'Nomos' }
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'INVALID_REQUEST');
    });

    it('returns determination for valid request', async () => {
      const res = await req(server, 'POST', '/scope-query',
        { ap_ref: 'urn:test:ap:1', action: 'Create a knowledge base entity', intent: 'KB management' },
        { 'X-Source-Organ': 'Nomos' }
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.ap_ref, 'urn:test:ap:1');
      assert.equal(res.body.determination, 'AMBIGUOUS'); // stub
      assert.equal(res.body.bor_version, 'test-1.0.0');
      assert.equal(res.body.bor_hash.length, 64);
      assert.ok(res.body.timestamp);
      assert.equal(res.body.requester, 'Nomos');
    });

    it('sets escalation_required for AMBIGUOUS', async () => {
      const res = await req(server, 'POST', '/scope-query',
        { ap_ref: 'urn:test:ap:2', action: 'Some action' },
        { 'X-Source-Organ': 'Nomos' }
      );
      assert.equal(res.body.determination, 'AMBIGUOUS');
      assert.equal(res.body.escalation_required, true);
    });

    it('records determination in store', async () => {
      const countBefore = determinationStore.query().count;
      await req(server, 'POST', '/scope-query',
        { ap_ref: 'urn:test:ap:store', action: 'Test store' },
        { 'X-Source-Organ': 'Nomos' }
      );
      const countAfter = determinationStore.query().count;
      assert.equal(countAfter, countBefore + 1);
    });
  });

  describe('GET /determinations', () => {
    it('returns recorded determinations', async () => {
      const res = await req(server, 'GET', '/determinations');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.determinations));
      assert.ok(res.body.count > 0);
    });

    it('filters by ap_ref', async () => {
      const res = await req(server, 'GET', '/determinations?ap_ref=urn:test:ap:store');
      assert.equal(res.status, 200);
      assert.ok(res.body.determinations.every(d => d.ap_ref === 'urn:test:ap:store'));
    });

    it('respects limit parameter', async () => {
      const res = await req(server, 'GET', '/determinations?limit=1');
      assert.equal(res.status, 200);
      assert.ok(res.body.determinations.length <= 1);
    });
  });

  describe('GET /bor/version', () => {
    it('returns BoR version info', async () => {
      const res = await req(server, 'GET', '/bor/version');
      assert.equal(res.status, 200);
      assert.equal(res.body.version, 'test-1.0.0');
      assert.equal(res.body.hash.length, 64);
      assert.equal(res.body.clause_count, 12);
      assert.equal(res.body.article_count, 6);
    });
  });
});

describe('Scope Query with missing BoR', () => {
  let server;

  before(async () => {
    globalThis.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ concepts: [] }),
    });

    const app = express();
    app.use(express.json());
    const routes = createScopeRoutes({
      config: { borPath: '/nonexistent/bor.md', graphUrl: 'http://127.0.0.1:4020' },
      determinationStore: createDeterminationStore(),
      evaluateScope: stubEvaluateScope,
    });
    app.use(routes);
    server = await new Promise(resolve => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (server) await new Promise(resolve => server.close(resolve));
  });

  it('returns 503 when BoR file missing', async () => {
    const res = await req(server, 'POST', '/scope-query',
      { ap_ref: 'ap1', action: 'test' },
      { 'X-Source-Organ': 'Nomos' }
    );
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'BOR_DOCUMENT_UNAVAILABLE');
    assert.equal(res.body.escalation_required, true);
  });
});
