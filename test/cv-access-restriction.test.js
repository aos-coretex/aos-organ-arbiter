/**
 * CV Category 4: Access restriction enforcement
 * Verifies Arbiter rejects queries from non-Nomos/non-Human_Principal organs.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createScopeRoutes } from '../server/routes/scope.js';
import { createDeterminationStore } from '../lib/determination-store.js';
import { handleDirectedMessage } from '../handlers/spine-commands.js';
import { createEscalationStore } from '../server/routes/human.js';
import { createDraftStore } from '../server/routes/amendments.js';
import { createAmbiguityTracker } from '../lib/ambiguity-tracker.js';

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

describe('CV: Access restriction', () => {
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
      evaluateScope: async () => ({ determination: 'AMBIGUOUS', cited_clauses: [], confidence: 0, reasoning: 'stub' }),
    }));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (server) await new Promise(r => server.close(r));
  });

  it('rejects query from unauthorized organ with 403', async () => {
    const res = await req(server, 'POST', '/scope-query', {
      ap_ref: 'urn:test:ap:cv4a', action: 'any action',
    }, { 'X-Source-Organ': 'Thalamus' });

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'UNAUTHORIZED_QUERIER');
  });

  it('rejects query with no source organ', async () => {
    const res = await req(server, 'POST', '/scope-query', {
      ap_ref: 'urn:test:ap:cv4b', action: 'any action',
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'UNAUTHORIZED_QUERIER');
  });

  it('rejects Spine directed APM from unauthorized organ', async () => {
    const deps = {
      config: { name: 'Arbiter', port: 4021, borPath: fixturePath, graphUrl: 'http://127.0.0.1:4020' },
      stores: {
        determinationStore: createDeterminationStore(),
        escalationStore: createEscalationStore(),
        draftStore: createDraftStore(),
        ambiguityTracker: createAmbiguityTracker(),
      },
      spineRef: () => null,
    };
    const result = await handleDirectedMessage({
      type: 'APM',
      source_organ: 'Glia',
      payload: { action: 'test', ap_ref: 'ap1' },
    }, deps);
    assert.equal(result.error, 'UNAUTHORIZED_QUERIER');
  });
});
