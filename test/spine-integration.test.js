import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleDirectedMessage } from '../handlers/spine-commands.js';
import { createDeterminationStore } from '../lib/determination-store.js';
import { createEscalationStore } from '../server/routes/human.js';
import { createDraftStore } from '../server/routes/amendments.js';
import { createAmbiguityTracker } from '../lib/ambiguity-tracker.js';

const originalFetch = globalThis.fetch;

function createTestDeps() {
  return {
    config: {
      name: 'Arbiter',
      port: 4021,
      borPath: new URL('../test/fixtures/test-bor.md', import.meta.url).pathname,
      graphUrl: 'http://127.0.0.1:4020',
    },
    stores: {
      determinationStore: createDeterminationStore(),
      escalationStore: createEscalationStore(),
      draftStore: createDraftStore(),
      ambiguityTracker: createAmbiguityTracker(),
    },
    spineRef: () => null,
  };
}

describe('Spine directed message handlers', () => {
  // Mock fetch for Graph adapter calls within handlers
  beforeEach(() => {
    // Default: Graph returns no registered versions (no mismatch)
    globalThis.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ concepts: [] }),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('Access control', () => {
    it('rejects APM from unauthorized organ', async () => {
      const deps = createTestDeps();
      const result = await handleDirectedMessage({
        type: 'APM',
        source_organ: 'Thalamus',
        payload: { action: 'test', ap_ref: 'ap1' },
      }, deps);
      assert.equal(result.error, 'UNAUTHORIZED_QUERIER');
    });

    it('rejects HOM from unauthorized organ', async () => {
      const deps = createTestDeps();
      const result = await handleDirectedMessage({
        type: 'HOM',
        source_organ: 'Glia',
        payload: { hom_id: 'h1', decision: 'approve' },
      }, deps);
      assert.equal(result.error, 'UNAUTHORIZED_QUERIER');
    });

    it('accepts OTM from any organ (OTM is unrestricted)', async () => {
      const deps = createTestDeps();
      const result = await handleDirectedMessage({
        type: 'OTM',
        source_organ: 'Vigil',
        payload: { event_type: 'health_check' },
      }, deps);
      assert.equal(result.status, 'ok');
    });
  });

  describe('OTM handlers', () => {
    it('handles health_check', async () => {
      const deps = createTestDeps();
      const result = await handleDirectedMessage({
        type: 'OTM',
        source_organ: 'Vigil',
        payload: { event_type: 'health_check' },
      }, deps);
      assert.equal(result.status, 'ok');
      assert.equal(result.organ, 'Arbiter');
    });

    it('handles bor_conflict_proposal from Senate', async () => {
      const deps = createTestDeps();
      const result = await handleDirectedMessage({
        type: 'OTM',
        source_organ: 'Senate',
        payload: {
          event_type: 'bor_conflict_proposal',
          per_ref: 'urn:test:per:1',
          rationale: 'Test conflict',
          proposed_language: 'Add clause...',
          impact_analysis: 'None',
          affected_clauses: ['I.1'],
        },
      }, deps);
      assert.equal(result.status, 'proposal_received');
      assert.ok(result.draft_id);
      assert.ok(result.hom_id);
    });

    it('returns null for unhandled OTM event types', async () => {
      const deps = createTestDeps();
      const result = await handleDirectedMessage({
        type: 'OTM',
        source_organ: 'Spine',
        payload: { event_type: 'some_unknown_event' },
      }, deps);
      assert.equal(result, null);
    });
  });

  describe('HOM handlers', () => {
    it('resolves pending escalation', async () => {
      const deps = createTestDeps();
      deps.stores.escalationStore.add({
        hom_id: 'urn:llm-ops:hom:test1',
        decision_type: 'bor_ambiguity',
        status: 'sent',
        sent_at: new Date().toISOString(),
      });

      const result = await handleDirectedMessage({
        type: 'HOM',
        source_organ: 'Human_Principal',
        payload: {
          hom_id: 'urn:llm-ops:hom:test1',
          decision: 'Action is IN_SCOPE per clause I.1',
        },
      }, deps);
      assert.equal(result.status, 'received');
      assert.equal(result.decision, 'Action is IN_SCOPE per clause I.1');

      const escalation = deps.stores.escalationStore.get('urn:llm-ops:hom:test1');
      assert.equal(escalation.status, 'received');
    });

    it('returns NOT_FOUND for unknown HOM', async () => {
      const deps = createTestDeps();
      const result = await handleDirectedMessage({
        type: 'HOM',
        source_organ: 'Human_Principal',
        payload: { hom_id: 'nonexistent', decision: 'approve' },
      }, deps);
      assert.equal(result.error, 'NOT_FOUND');
    });

    it('returns INVALID_HOM when missing required fields', async () => {
      const deps = createTestDeps();
      const result = await handleDirectedMessage({
        type: 'HOM',
        source_organ: 'Human_Principal',
        payload: { hom_id: 'test1' }, // missing decision
      }, deps);
      assert.equal(result.error, 'INVALID_HOM');
    });
  });

  describe('APM handlers', () => {
    it('redirects synchronous scope queries to HTTP', async () => {
      const deps = createTestDeps();
      const result = await handleDirectedMessage({
        type: 'APM',
        source_organ: 'Nomos',
        payload: { action: 'test action', ap_ref: 'ap1' },
      }, deps);
      assert.equal(result.status, 'redirect_to_http');
      assert.ok(result.http_url.includes('4021'));
    });

    it('returns INVALID_APM when missing required fields', async () => {
      const deps = createTestDeps();
      const result = await handleDirectedMessage({
        type: 'APM',
        source_organ: 'Nomos',
        payload: { action: 'test' }, // missing ap_ref
      }, deps);
      assert.equal(result.error, 'INVALID_APM');
    });
  });

  describe('Unknown message types', () => {
    it('returns null for unknown type', async () => {
      const deps = createTestDeps();
      const result = await handleDirectedMessage({
        type: 'UNKNOWN',
        source_organ: 'Spine',
        payload: {},
      }, deps);
      assert.equal(result, null);
    });
  });
});
