/**
 * CV Category 1: IN_SCOPE determination
 * Verifies Arbiter returns IN_SCOPE with cited clauses for a permitted action.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createScopeRoutes } from '../server/routes/scope.js';
import { createDeterminationStore } from '../lib/determination-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'test-bor.md');

function req(server, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const r = http.request({
      hostname: '127.0.0.1', port: addr.port, path, method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

describe('CV: IN_SCOPE determination', () => {
  let server;
  const originalFetch = globalThis.fetch;

  before(async () => {
    globalThis.fetch = () => Promise.resolve({
      ok: true, json: () => Promise.resolve({ concepts: [] }),
    });

    const app = express();
    app.use(express.json());
    app.use(createScopeRoutes({
      config: { borPath: fixturePath, graphUrl: 'http://127.0.0.1:4020' },
      determinationStore: createDeterminationStore(),
      evaluateScope: async () => ({
        determination: 'IN_SCOPE',
        cited_clauses: [{ clause_id: 'I.1', text_ref: 'authorized operations', relevance: 'covers knowledge management' }],
        confidence: 0.92,
        reasoning: 'Clause I.1 explicitly permits knowledge management operations.',
      }),
    }));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (server) await new Promise(r => server.close(r));
  });

  it('returns IN_SCOPE for authorized operation with cited clauses', async () => {
    const res = await req(server, 'POST', '/scope-query', {
      ap_ref: 'urn:test:ap:cv1',
      action: 'Create a new knowledge base entity',
      targets: [],
      intent: 'Knowledge management',
    }, { 'X-Source-Organ': 'Nomos' });

    assert.equal(res.status, 200);
    assert.equal(res.body.determination, 'IN_SCOPE');
    assert.equal(res.body.cited_clauses[0].clause_id, 'I.1');
    assert.equal(res.body.bor_version, 'test-1.0.0');
    assert.equal(res.body.bor_hash.length, 64);
    assert.ok(res.body.confidence > 0.5);
    assert.ok(res.body.reasoning.length > 0);
  });
});
