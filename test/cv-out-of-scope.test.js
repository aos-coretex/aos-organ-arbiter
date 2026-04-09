/**
 * CV Category 2: OUT_OF_SCOPE determination
 * Verifies Arbiter returns OUT_OF_SCOPE with cited clauses for a prohibited action.
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

describe('CV: OUT_OF_SCOPE determination', () => {
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
        determination: 'OUT_OF_SCOPE',
        cited_clauses: [{ clause_id: 'II.1', text_ref: 'data exfiltration', relevance: 'explicitly prohibited' }],
        confidence: 0.95,
        reasoning: 'Clause II.1 explicitly prohibits transmitting platform data to external systems.',
      }),
    }));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (server) await new Promise(r => server.close(r));
  });

  it('returns OUT_OF_SCOPE for clearly prohibited action with cited clauses', async () => {
    const res = await req(server, 'POST', '/scope-query', {
      ap_ref: 'urn:test:ap:cv2',
      action: 'Send platform data to external analytics service',
      intent: 'Analytics',
    }, { 'X-Source-Organ': 'Nomos' });

    assert.equal(res.status, 200);
    assert.equal(res.body.determination, 'OUT_OF_SCOPE');
    assert.equal(res.body.cited_clauses[0].clause_id, 'II.1');
    assert.ok(res.body.confidence > 0.5);
    assert.ok(!res.body.escalation_required); // OUT_OF_SCOPE does not escalate
  });
});
