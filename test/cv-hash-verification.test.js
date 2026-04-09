/**
 * CV Category 5: Hash verification
 * Verifies Arbiter detects BoR modification via SHA-256 hash mismatch.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { createScopeRoutes } from '../server/routes/scope.js';
import { createDeterminationStore } from '../lib/determination-store.js';
import { computeHash, loadBoR } from '../lib/bor-loader.js';
import { verifyBorHash, registerBorVersion } from '../lib/graph-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'test-bor.md');
const originalFetch = globalThis.fetch;

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

describe('CV: Hash verification', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('detects BoR modification via hash mismatch (returns 409)', async () => {
    // Mock Graph to return a registered hash that does NOT match the fixture
    globalThis.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        concepts: [{ urn: 'urn:graphheight:bor:test-1.0.0', data: { version: 'test-1.0.0', hash: 'stale_hash_that_does_not_match' } }],
      }),
    });

    const app = express();
    app.use(express.json());
    app.use(createScopeRoutes({
      config: { borPath: fixturePath, graphUrl: 'http://127.0.0.1:4020' },
      determinationStore: createDeterminationStore(),
      evaluateScope: async () => ({ determination: 'AMBIGUOUS', cited_clauses: [], confidence: 0, reasoning: 'stub' }),
    }));
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

    const res = await req(server, 'POST', '/scope-query', {
      ap_ref: 'urn:test:ap:cv5a', action: 'any action',
    }, { 'X-Source-Organ': 'Nomos' });

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'BOR_VERSION_MISMATCH');

    await new Promise(r => server.close(r));
  });

  it('registers hash on first boot when Graph has no version', async () => {
    let registeredConcept = null;
    globalThis.fetch = (url, opts) => {
      if (opts?.method === 'POST') {
        registeredConcept = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      // GET returns empty — no registered version
      return Promise.resolve({
        ok: true, json: () => Promise.resolve({ concepts: [] }),
      });
    };

    const bor = await loadBoR(fixturePath);
    const verification = await verifyBorHash('http://127.0.0.1:4020', bor.hash);
    assert.equal(verification.registered, null);

    // Simulate first-boot registration
    await registerBorVersion('http://127.0.0.1:4020', {
      version: bor.version, hash: bor.hash, clauseCount: bor.clauseCount,
    });
    assert.ok(registeredConcept);
    assert.equal(registeredConcept.type, 'bor_version');
    assert.equal(registeredConcept.data.hash, bor.hash);
  });

  it('verifies hash matches registered version', async () => {
    const bor = await loadBoR(fixturePath);
    globalThis.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        concepts: [{ urn: 'urn:graphheight:bor:test-1.0.0', data: { version: 'test-1.0.0', hash: bor.hash } }],
      }),
    });

    const result = await verifyBorHash('http://127.0.0.1:4020', bor.hash);
    assert.equal(result.verified, true);
    assert.equal(result.mismatch, false);
  });
});
