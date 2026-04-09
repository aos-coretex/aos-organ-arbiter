import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createAmbiguityTracker } from '../lib/ambiguity-tracker.js';
import { createAmendmentRoutes, createDraftStore } from '../server/routes/amendments.js';
import { createEscalationStore } from '../server/routes/human.js';
import { handleSenateProposal } from '../lib/senate-conflict-handler.js';

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

describe('Ambiguity tracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = createAmbiguityTracker({ threshold: 3 });
  });

  it('does not trigger below threshold', () => {
    const r1 = tracker.record({ action: 'modify naming convention', ap_ref: 'ap1' });
    assert.equal(r1.threshold_reached, false);
    assert.equal(r1.count, 1);

    const r2 = tracker.record({ action: 'modify naming convention', ap_ref: 'ap2' });
    assert.equal(r2.threshold_reached, false);
    assert.equal(r2.count, 2);
  });

  it('triggers at threshold', () => {
    tracker.record({ action: 'modify naming convention', ap_ref: 'ap1' });
    tracker.record({ action: 'modify naming convention', ap_ref: 'ap2' });
    const r3 = tracker.record({ action: 'modify naming convention', ap_ref: 'ap3' });
    assert.equal(r3.threshold_reached, true);
    assert.equal(r3.count, 3);
  });

  it('groups similar actions by keyword normalization', () => {
    tracker.record({ action: 'Modify naming convention', ap_ref: 'ap1' });
    tracker.record({ action: 'modify naming convention', ap_ref: 'ap2' });
    const r3 = tracker.record({ action: 'Modify NAMING convention!', ap_ref: 'ap3' });
    // All three normalize to the same keyword set: "convention modify naming"
    assert.equal(r3.threshold_reached, true);
  });

  it('getThresholdPatterns returns only patterns at/above threshold', () => {
    tracker.record({ action: 'modify naming convention', ap_ref: 'ap1' });
    tracker.record({ action: 'modify naming convention', ap_ref: 'ap2' });
    tracker.record({ action: 'modify naming convention', ap_ref: 'ap3' });
    tracker.record({ action: 'delete infrastructure files', ap_ref: 'ap4' });

    const threshold = tracker.getThresholdPatterns();
    assert.equal(threshold.length, 1);
    assert.equal(threshold[0].count, 3);
  });

  it('getStats reports correct totals', () => {
    tracker.record({ action: 'modify naming convention', ap_ref: 'ap1' });
    tracker.record({ action: 'modify naming convention', ap_ref: 'ap2' });
    tracker.record({ action: 'delete infrastructure files', ap_ref: 'ap3' });

    const stats = tracker.getStats();
    assert.equal(stats.tracked_patterns, 2);
    assert.equal(stats.total_ambiguous, 3);
  });

  it('handles empty/short action strings', () => {
    const r = tracker.record({ action: 'do', ap_ref: 'ap1' });
    assert.equal(r.threshold_reached, false);
    assert.equal(r.count, 0); // "do" is <=3 chars, filtered out
  });
});

describe('Draft store', () => {
  it('stores and retrieves drafts', () => {
    const store = createDraftStore();
    store.add({ draft_id: 'd1', status: 'drafted', human_decision: null });
    assert.equal(store.get('d1').status, 'drafted');
  });

  it('getStats counts correctly', () => {
    const store = createDraftStore();
    store.add({ draft_id: 'd1', human_decision: null });
    store.add({ draft_id: 'd2', human_decision: 'approve' });
    store.add({ draft_id: 'd3', human_decision: 'reject' });
    const stats = store.getStats();
    assert.equal(stats.total_drafts, 3);
    assert.equal(stats.pending_review, 1);
    assert.equal(stats.approved, 1);
    assert.equal(stats.rejected, 1);
  });

  it('returns null for nonexistent draft', () => {
    const store = createDraftStore();
    assert.equal(store.get('nonexistent'), null);
  });
});

describe('Senate BOR_CONFLICT handler', () => {
  it('creates draft and escalation from Senate proposal', () => {
    const draftStore = createDraftStore();
    const escalationStore = createEscalationStore();

    const result = handleSenateProposal({
      per_ref: 'urn:llm-ops:per:test',
      rationale: 'Clause I.1 conflicts with new infrastructure scope',
      proposed_language: 'Expand Clause I.1 to include...',
      impact_analysis: 'Minimal impact on existing operations',
      affected_clauses: ['I.1'],
    }, { draftStore, escalationStore });

    assert.ok(result.draft_id);
    assert.ok(result.hom_id);

    const draft = draftStore.get(result.draft_id);
    assert.equal(draft.source, 'Senate');
    assert.equal(draft.triggering_per, 'urn:llm-ops:per:test');
    assert.equal(draft.delivered, true);

    const escalation = escalationStore.get(result.hom_id);
    assert.equal(escalation.decision_type, 'amendment_proposal');
    assert.equal(escalation.draft_id, result.draft_id);
  });

  it('handles missing optional fields gracefully', () => {
    const draftStore = createDraftStore();
    const escalationStore = createEscalationStore();

    const result = handleSenateProposal({}, { draftStore, escalationStore });
    assert.ok(result.draft_id);

    const draft = draftStore.get(result.draft_id);
    assert.equal(draft.triggering_per, null);
    assert.equal(draft.rationale, 'Senate BOR_CONFLICT escalation');
  });
});

describe('POST /bor/amendment-draft (HTTP)', () => {
  let server, draftStore, escalationStore;

  before(async () => {
    draftStore = createDraftStore();
    escalationStore = createEscalationStore();
    const app = express();
    app.use(express.json());
    app.use(createAmendmentRoutes({ config: {}, escalationStore, draftStore }));
    server = await new Promise(resolve => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  it('creates draft with valid input', async () => {
    const res = await req(server, 'POST', '/bor/amendment-draft', {
      rationale: 'Clause I.1 needs expansion for infrastructure automation',
      proposed_language: 'Expand Clause I.1 to include infrastructure provisioning.',
      impact_analysis: 'Permits automated infrastructure changes within platform boundary.',
      affected_clauses: ['I.1'],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'drafted');
    assert.ok(res.body.draft_id.startsWith('urn:llm-ops:amendment-draft:'));
    assert.ok(res.body.hom_id.startsWith('urn:llm-ops:hom:'));

    // Verify draft was stored
    const draft = draftStore.get(res.body.draft_id);
    assert.equal(draft.delivered, true);
    assert.equal(draft.rationale, 'Clause I.1 needs expansion for infrastructure automation');
  });

  it('rejects missing required fields', async () => {
    const res = await req(server, 'POST', '/bor/amendment-draft', {
      rationale: 'some rationale',
      // missing proposed_language and impact_analysis
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'INVALID_REQUEST');
  });
});
