/**
 * Senate BOR_CONFLICT handler.
 *
 * Per architectural conclusions (Section 10):
 *   Senate delivers BoR amendment proposals to Arbiter via OTM
 *   (the PEM was already consumed by Senate; the proposal is a new artifact).
 *
 * Arbiter receives the proposal, packages it, and forwards to the
 * human principal via HOM. Arbiter does NOT evaluate or approve
 * Senate proposals — only delivers them.
 */

import { generateUrn } from '@coretex/organ-boot/urn';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * Handle a Senate BOR_CONFLICT proposal delivered via OTM.
 *
 * @param {object} payload — OTM payload with proposal data
 * @param {{ escalationStore: object, draftStore: object }} stores
 * @returns {{ draft_id: string, hom_id: string }}
 */
export function handleSenateProposal(payload, { escalationStore, draftStore }) {
  const {
    per_ref,
    rationale,
    proposed_language,
    impact_analysis,
    affected_clauses = [],
  } = payload;

  log('senate_bor_conflict_received', { per_ref });

  const draft_id = generateUrn('amendment-draft');
  const draft = {
    draft_id,
    status: 'drafted',
    rationale: rationale || 'Senate BOR_CONFLICT escalation',
    proposed_language: proposed_language || '',
    impact_analysis: impact_analysis || '',
    triggering_per: per_ref || null,
    affected_clauses,
    created_at: new Date().toISOString(),
    delivered: false,
    human_decision: null,
    source: 'Senate',
  };
  draftStore.add(draft);

  // Forward to human principal via HOM
  const hom_id = generateUrn('hom');
  const escalation = {
    hom_id,
    decision_type: 'amendment_proposal',
    context: `Senate BOR_CONFLICT proposal (PER: ${per_ref || 'none'}): ${draft.rationale}`,
    question: 'Senate has identified a BoR conflict. Review the proposed amendment. Approve, modify, or reject.',
    options: ['approve', 'modify', 'reject'],
    draft_id,
    ap_ref: null,
    status: 'sent',
    sent_at: new Date().toISOString(),
    resolved_at: null,
    decision: null,
  };
  escalationStore.add(escalation);
  draft.delivered = true;
  draft.hom_id = hom_id;
  draftStore.update(draft);

  log('senate_proposal_forwarded_to_human', { draft_id, hom_id, per_ref });

  return { draft_id, hom_id };
}
