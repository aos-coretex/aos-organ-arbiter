/**
 * Human oversight routes — HOM escalation and response handling.
 *
 * POST /human/escalate  — send a HOM to the human principal
 * POST /human/receive   — receive a HOM response from the human principal
 */

import { Router } from 'express';
import { generateUrn } from '@coretex/organ-boot/urn';

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.escalationStore — tracks pending escalations
 */
export function createHumanRoutes({ config, escalationStore }) {
  const router = Router();

  /**
   * POST /human/escalate
   *
   * Send a HOM to the human principal.
   * Used for: ambiguity escalation, amendment proposal delivery, scope clarification.
   *
   * Input: { decision_type, context, question, options, draft_id?, ap_ref? }
   * Output: { hom_id, status: "sent", decision_type, timestamp }
   */
  router.post('/human/escalate', async (req, res) => {
    const { decision_type, context, question, options = [], draft_id, ap_ref } = req.body;

    const validTypes = ['bor_ambiguity', 'amendment_proposal', 'scope_clarification'];
    if (!decision_type || !validTypes.includes(decision_type)) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: `decision_type must be one of: ${validTypes.join(', ')}`,
      });
    }

    if (!context || !question) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'context and question are required',
      });
    }

    const hom_id = generateUrn('hom');
    const escalation = {
      hom_id,
      decision_type,
      context,
      question,
      options,
      draft_id: draft_id || null,
      ap_ref: ap_ref || null,
      status: 'sent',
      sent_at: new Date().toISOString(),
      resolved_at: null,
      decision: null,
    };

    escalationStore.add(escalation);

    // In relay a8j-5, this also publishes a HOM via Spine
    res.status(201).json({
      hom_id,
      status: 'sent',
      decision_type,
      timestamp: escalation.sent_at,
    });
  });

  /**
   * POST /human/receive
   *
   * Receive a HOM response from the human principal.
   *
   * Input: { hom_id, decision, new_bor_version?, clarification? }
   * Output: { hom_id, status: "received", decision, timestamp }
   */
  router.post('/human/receive', async (req, res) => {
    const { hom_id, decision, new_bor_version, clarification } = req.body;

    if (!hom_id || !decision) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'hom_id and decision are required',
      });
    }

    const escalation = escalationStore.get(hom_id);
    if (!escalation) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: `No pending escalation with hom_id: ${hom_id}`,
      });
    }

    // Resolve the escalation
    escalation.status = 'received';
    escalation.decision = decision;
    escalation.resolved_at = new Date().toISOString();
    if (new_bor_version) escalation.new_bor_version = new_bor_version;
    if (clarification) escalation.clarification = clarification;

    escalationStore.update(escalation);

    res.json({
      hom_id,
      status: 'received',
      decision,
      timestamp: escalation.resolved_at,
    });
  });

  return router;
}

/**
 * In-memory escalation store for pending HOMs.
 */
export function createEscalationStore() {
  /** @type {Map<string, object>} */
  const store = new Map();

  return {
    add(escalation) {
      store.set(escalation.hom_id, escalation);
    },
    get(homId) {
      return store.get(homId) || null;
    },
    update(escalation) {
      store.set(escalation.hom_id, escalation);
    },
    getPending() {
      return [...store.values()].filter(e => e.status === 'sent');
    },
    getAll() {
      return [...store.values()];
    },
    getStats() {
      const all = [...store.values()];
      return {
        total: all.length,
        pending: all.filter(e => e.status === 'sent').length,
        resolved: all.filter(e => e.status === 'received').length,
      };
    },
  };
}
