/**
 * Amendment proposal routes.
 *
 * POST /bor/amendment-draft — Draft a non-binding BoR amendment proposal.
 *
 * Arbiter drafts proposals but NEVER enacts them.
 * The human principal must approve, modify, or reject.
 * Proposals are delivered to the human principal via HOM.
 */

import { Router } from 'express';
import { generateUrn } from '@coretex/organ-boot/urn';

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.escalationStore — from human.js (pending HOM tracking)
 * @param {object} deps.draftStore — in-memory amendment draft storage
 */
export function createAmendmentRoutes({ config, escalationStore, draftStore }) {
  const router = Router();

  /**
   * POST /bor/amendment-draft
   *
   * Input: {
   *   rationale: string,
   *   proposed_language: string,
   *   impact_analysis: string,
   *   triggering_per?: string (PER URN if from Senate BOR_CONFLICT),
   *   affected_clauses: string[]
   * }
   *
   * Output: { draft_id: string, status: "drafted", timestamp: ISO8601 }
   *
   * After drafting, automatically creates a HOM escalation
   * to deliver the proposal to the human principal.
   */
  router.post('/bor/amendment-draft', async (req, res) => {
    const {
      rationale,
      proposed_language,
      impact_analysis,
      triggering_per,
      affected_clauses = [],
    } = req.body;

    // Validate required fields
    if (!rationale || !proposed_language || !impact_analysis) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'rationale, proposed_language, and impact_analysis are required',
      });
    }

    const draft_id = generateUrn('amendment-draft');
    const draft = {
      draft_id,
      status: 'drafted',
      rationale,
      proposed_language,
      impact_analysis,
      triggering_per: triggering_per || null,
      affected_clauses,
      created_at: new Date().toISOString(),
      delivered: false,
      human_decision: null,
    };

    draftStore.add(draft);

    // Auto-escalate: create HOM to deliver the proposal to the human principal
    const hom_id = generateUrn('hom');
    const escalation = {
      hom_id,
      decision_type: 'amendment_proposal',
      context: `Amendment proposal ${draft_id}: ${rationale}`,
      question: 'Review this proposed BoR amendment. Approve, modify, or reject.',
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

    res.status(201).json({
      draft_id,
      status: 'drafted',
      hom_id,
      timestamp: draft.created_at,
    });
  });

  return router;
}

/**
 * In-memory amendment draft store.
 */
export function createDraftStore() {
  /** @type {Map<string, object>} */
  const store = new Map();

  return {
    add(draft) {
      store.set(draft.draft_id, draft);
    },
    get(draftId) {
      return store.get(draftId) || null;
    },
    update(draft) {
      store.set(draft.draft_id, draft);
    },
    getAll() {
      return [...store.values()];
    },
    getStats() {
      const all = [...store.values()];
      return {
        total_drafts: all.length,
        pending_review: all.filter(d => d.human_decision === null).length,
        approved: all.filter(d => d.human_decision === 'approve').length,
        rejected: all.filter(d => d.human_decision === 'reject').length,
      };
    },
  };
}
