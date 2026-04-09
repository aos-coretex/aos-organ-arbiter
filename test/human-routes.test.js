import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createHumanRoutes, createEscalationStore } from '../server/routes/human.js';

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

describe('Human Oversight Routes', () => {
  let server, escalationStore;

  before(async () => {
    escalationStore = createEscalationStore();
    const app = express();
    app.use(express.json());
    app.use(createHumanRoutes({ config: {}, escalationStore }));
    server = await new Promise(resolve => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  describe('POST /human/escalate', () => {
    it('creates escalation with valid input', async () => {
      const res = await req(server, 'POST', '/human/escalate', {
        decision_type: 'bor_ambiguity',
        context: 'Clause III.1 may apply to naming conventions',
        question: 'Does modifying naming conventions constitute core identity change?',
        options: ['yes', 'no'],
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.status, 'sent');
      assert.equal(res.body.decision_type, 'bor_ambiguity');
      assert.ok(res.body.hom_id.startsWith('urn:llm-ops:hom:'));
      assert.ok(res.body.timestamp);
    });

    it('rejects invalid decision_type', async () => {
      const res = await req(server, 'POST', '/human/escalate', {
        decision_type: 'invalid_type',
        context: 'test',
        question: 'test',
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'INVALID_REQUEST');
    });

    it('rejects missing context', async () => {
      const res = await req(server, 'POST', '/human/escalate', {
        decision_type: 'bor_ambiguity',
        question: 'test',
      });
      assert.equal(res.status, 400);
    });

    it('rejects missing question', async () => {
      const res = await req(server, 'POST', '/human/escalate', {
        decision_type: 'bor_ambiguity',
        context: 'test',
      });
      assert.equal(res.status, 400);
    });
  });

  describe('POST /human/receive', () => {
    it('resolves a pending escalation', async () => {
      // First create an escalation
      const esc = await req(server, 'POST', '/human/escalate', {
        decision_type: 'scope_clarification',
        context: 'Test escalation',
        question: 'Is this allowed?',
        options: ['yes', 'no'],
      });
      const hom_id = esc.body.hom_id;

      // Now resolve it
      const res = await req(server, 'POST', '/human/receive', {
        hom_id,
        decision: 'Action is IN_SCOPE per clause I.1',
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.hom_id, hom_id);
      assert.equal(res.body.status, 'received');
      assert.equal(res.body.decision, 'Action is IN_SCOPE per clause I.1');
      assert.ok(res.body.timestamp);
    });

    it('returns 404 for unknown hom_id', async () => {
      const res = await req(server, 'POST', '/human/receive', {
        hom_id: 'urn:llm-ops:hom:nonexistent',
        decision: 'test',
      });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'NOT_FOUND');
    });

    it('rejects missing hom_id', async () => {
      const res = await req(server, 'POST', '/human/receive', {
        decision: 'test',
      });
      assert.equal(res.status, 400);
    });

    it('rejects missing decision', async () => {
      const res = await req(server, 'POST', '/human/receive', {
        hom_id: 'urn:llm-ops:hom:test',
      });
      assert.equal(res.status, 400);
    });
  });

  describe('Escalation store', () => {
    it('tracks pending and resolved counts', () => {
      const stats = escalationStore.getStats();
      assert.ok(stats.total >= 2); // At least the two we created
      assert.ok(stats.resolved >= 1); // At least one resolved
    });
  });
});

describe('Determination store', () => {
  // Import separately to test in isolation
  let createDeterminationStore;

  before(async () => {
    const mod = await import('../lib/determination-store.js');
    createDeterminationStore = mod.createDeterminationStore;
  });

  it('adds and queries determinations', () => {
    const store = createDeterminationStore();
    store.add({ ap_ref: 'ap1', determination: 'IN_SCOPE', cited_clauses: [], bor_version: '1.0.0', bor_hash: 'abc', confidence: 0.9, reasoning: 'test' });
    store.add({ ap_ref: 'ap2', determination: 'AMBIGUOUS', cited_clauses: [], bor_version: '1.0.0', bor_hash: 'abc', confidence: 0.3, reasoning: 'test' });

    const all = store.query();
    assert.equal(all.count, 2);
  });

  it('filters by determination type', () => {
    const store = createDeterminationStore();
    store.add({ ap_ref: 'ap1', determination: 'IN_SCOPE' });
    store.add({ ap_ref: 'ap2', determination: 'AMBIGUOUS' });
    store.add({ ap_ref: 'ap3', determination: 'OUT_OF_SCOPE' });

    const ambiguous = store.query({ determination: 'AMBIGUOUS' });
    assert.equal(ambiguous.count, 1);
    assert.equal(ambiguous.determinations[0].ap_ref, 'ap2');
  });

  it('computes stats correctly', () => {
    const store = createDeterminationStore();
    store.add({ ap_ref: 'ap1', determination: 'IN_SCOPE' });
    store.add({ ap_ref: 'ap2', determination: 'AMBIGUOUS' });
    store.add({ ap_ref: 'ap3', determination: 'AMBIGUOUS' });

    const stats = store.getStats();
    assert.equal(stats.total_determinations, 3);
    assert.equal(stats.by_type.AMBIGUOUS, 2);
    assert.equal(stats.by_type.IN_SCOPE, 1);
    assert.ok(Math.abs(stats.ambiguity_rate - 2/3) < 0.001);
  });

  it('respects limit', () => {
    const store = createDeterminationStore();
    for (let i = 0; i < 10; i++) {
      store.add({ ap_ref: `ap${i}`, determination: 'IN_SCOPE' });
    }
    const result = store.query({ limit: 3 });
    assert.equal(result.determinations.length, 3);
    assert.equal(result.count, 10);
  });
});
