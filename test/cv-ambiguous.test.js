/**
 * CV Category 3: AMBIGUOUS determination — verify blocking
 * Verifies Arbiter returns AMBIGUOUS with escalation_required for edge cases.
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

describe('CV: AMBIGUOUS determination — blocks', () => {
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
        determination: 'AMBIGUOUS',
        cited_clauses: [{ clause_id: 'III.1', text_ref: 'identity immutability', relevance: 'naming may constitute identity' }],
        confidence: 0.3,
        reasoning: 'Unclear whether naming conventions constitute core identity under Clause III.1.',
      }),
    }));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (server) await new Promise(r => server.close(r));
  });

  it('returns AMBIGUOUS for edge case with escalation_required', async () => {
    const res = await req(server, 'POST', '/scope-query', {
      ap_ref: 'urn:test:ap:cv3',
      action: 'Modify the entity naming convention across all vaults',
      intent: 'Standardization',
    }, { 'X-Source-Organ': 'Nomos' });

    assert.equal(res.status, 200);
    assert.equal(res.body.determination, 'AMBIGUOUS');
    assert.equal(res.body.escalation_required, true);
    assert.ok(res.body.confidence < 0.5);
  });
});
