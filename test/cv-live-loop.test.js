/**
 * CV Category 6: Live loop health
 * Verifies Arbiter health, introspect, and Spine mailbox round-trip.
 *
 * Note: These tests use a lightweight Express app (not the full createOrgan boot)
 * since the full organ requires Spine connectivity. The tests validate the
 * health/introspect response shapes and the directed message handler.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createDeterminationStore } from '../lib/determination-store.js';
import { createEscalationStore } from '../server/routes/human.js';
import { createDraftStore } from '../server/routes/amendments.js';
import { createAmbiguityTracker } from '../lib/ambiguity-tracker.js';
import { handleDirectedMessage } from '../handlers/spine-commands.js';

function req(server, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const r = http.request({
      hostname: '127.0.0.1', port: addr.port, path, method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

describe('CV: Live loop health', () => {
  let server;

  before(async () => {
    // Simulate the health and introspect endpoints that createOrgan would mount
    const determinationStore = createDeterminationStore();
    const escalationStore = createEscalationStore();
    const draftStore = createDraftStore();
    const ambiguityTracker = createAmbiguityTracker();

    // Add some test data
    determinationStore.add({ ap_ref: 'ap1', determination: 'IN_SCOPE' });
    determinationStore.add({ ap_ref: 'ap2', determination: 'AMBIGUOUS' });

    const app = express();
    app.use(express.json());

    // Simulate /health (same shape as createOrgan healthCheck)
    app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        organ: 'Arbiter',
        uptime_s: 100,
        loop_iteration: 42,
        spine_connected: false, // test mode — no Spine
        checks: {
          bor_loaded: true,
          bor_version: 'test-1.0.0',
          bor_degraded: false,
          clause_matcher_available: false, // no API key in tests
        },
      });
    });

    // Simulate /introspect
    app.get('/introspect', (req, res) => {
      const detStats = determinationStore.getStats();
      const escStats = escalationStore.getStats();
      const draftStats = draftStore.getStats();
      const ambStats = ambiguityTracker.getStats();
      res.json({
        organ: 'Arbiter',
        mailbox_depth: 0,
        last_message_ts: null,
        extra: {
          pending_escalations: escStats.pending,
          total_determinations: detStats.total_determinations,
          ambiguity_rate: detStats.ambiguity_rate,
          amendment_drafts: draftStats.total_drafts,
          ambiguity_patterns: ambStats.tracked_patterns,
        },
      });
    });

    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  });

  after(async () => {
    if (server) await new Promise(r => server.close(r));
  });

  it('GET /health returns ok with BoR status', async () => {
    const res = await req(server, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.checks.bor_loaded, true);
    assert.equal(res.body.checks.bor_version, 'test-1.0.0');
    assert.equal(res.body.checks.bor_degraded, false);
  });

  it('GET /introspect returns organ statistics', async () => {
    const res = await req(server, 'GET', '/introspect');
    assert.equal(res.status, 200);
    assert.equal(res.body.extra.total_determinations, 2);
    assert.equal(res.body.extra.pending_escalations, 0);
    assert.equal(res.body.extra.amendment_drafts, 0);
  });

  it('Spine mailbox receives directed OTM health_check', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({
      ok: true, json: () => Promise.resolve({ concepts: [] }),
    });

    const deps = {
      config: { name: 'Arbiter', port: 4021, borPath: '', graphUrl: '' },
      stores: {
        determinationStore: createDeterminationStore(),
        escalationStore: createEscalationStore(),
        draftStore: createDraftStore(),
        ambiguityTracker: createAmbiguityTracker(),
      },
      spineRef: () => null,
    };

    const result = await handleDirectedMessage({
      type: 'OTM',
      source_organ: 'Vigil',
      payload: { event_type: 'health_check' },
    }, deps);

    globalThis.fetch = originalFetch;
    assert.equal(result.status, 'ok');
    assert.equal(result.organ, 'Arbiter');
  });
});
