/**
 * Spine directed message handlers for Arbiter.
 *
 * Arbiter consumes three message types on Spine:
 *   - OTM: BoR update notifications, Senate BOR_CONFLICT proposals, health checks
 *   - APM: Scope queries forwarded from Nomos (directed)
 *   - HOM: Human principal responses
 *
 * Access control: Only Nomos and Human Principal may send directed messages.
 * All other sources are rejected with UNAUTHORIZED_QUERIER.
 */

import { validateSpineSource } from '../lib/access-control.js';
import { loadBoR } from '../lib/bor-loader.js';
import { verifyBorHash } from '../lib/graph-adapter.js';
import { handleSenateProposal } from '../lib/senate-conflict-handler.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * Handle a directed message from Spine.
 *
 * @param {object} envelope - Spine message envelope
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.stores - { determinationStore, escalationStore, draftStore, ambiguityTracker }
 * @param {function} deps.spineRef - () => spine client reference
 * @returns {object|null} - response payload (for directed message reply)
 */
export async function handleDirectedMessage(envelope, { config, stores, spineRef }) {
  const messageType = envelope.type || envelope.payload?.type;
  const eventType = envelope.payload?.event_type;

  log('directed_message_received', {
    type: messageType,
    event_type: eventType,
    source: envelope.source_organ,
  });

  // Access control for APM and HOM
  if (messageType === 'APM' || messageType === 'HOM') {
    const { authorized, source } = validateSpineSource(envelope);
    if (!authorized) {
      return {
        error: 'UNAUTHORIZED_QUERIER',
        message: `Organ ${source} is not authorized to query Arbiter`,
      };
    }
  }

  switch (messageType) {
    case 'OTM': {
      return handleOTM(envelope, { config, stores });
    }

    case 'APM': {
      return handleAPM(envelope, { config, stores });
    }

    case 'HOM': {
      return handleHOM(envelope, { stores });
    }

    default:
      log('unknown_message_type', { type: messageType });
      return null;
  }
}

/**
 * Handle OTM directed messages.
 */
async function handleOTM(envelope, { config, stores }) {
  const eventType = envelope.payload?.event_type;

  switch (eventType) {
    case 'bor_conflict_proposal': {
      // Senate BOR_CONFLICT — forward to human principal
      const result = handleSenateProposal(
        envelope.payload,
        { escalationStore: stores.escalationStore, draftStore: stores.draftStore }
      );
      return { status: 'proposal_received', ...result };
    }

    case 'health_check': {
      return { status: 'ok', organ: 'Arbiter' };
    }

    default:
      log('unhandled_otm_event', { event_type: eventType });
      return null;
  }
}

/**
 * Handle APM directed messages (scope queries via Spine).
 *
 * Design decision: Scope queries require synchronous request-response semantics.
 * The organ definition states: "The scope determination is returned synchronously
 * via the /scope-query HTTP response." Spine's async model cannot guarantee the
 * inline response Nomos needs to continue adjudication. Therefore, Spine APM
 * handling redirects to the HTTP endpoint. This is the intended behavior.
 */
async function handleAPM(envelope, { config, stores }) {
  const { action, targets, intent, ap_ref } = envelope.payload || {};

  if (!action || !ap_ref) {
    return { error: 'INVALID_APM', message: 'action and ap_ref required in APM payload' };
  }

  try {
    const bor = await loadBoR(config.borPath);
    const verification = await verifyBorHash(config.graphUrl, bor.hash);

    if (verification.mismatch) {
      return {
        error: 'BOR_VERSION_MISMATCH',
        message: 'BoR hash does not match registered version',
      };
    }

    // Scope queries are synchronous — redirect to HTTP
    return {
      status: 'redirect_to_http',
      message: 'Use POST /scope-query for synchronous scope evaluation',
      http_url: `http://127.0.0.1:${config.port}/scope-query`,
    };
  } catch (err) {
    return { error: 'BOR_DOCUMENT_UNAVAILABLE', message: err.message };
  }
}

/**
 * Handle HOM directed messages (human principal responses).
 */
async function handleHOM(envelope, { stores }) {
  const { hom_id, decision, new_bor_version, clarification } = envelope.payload || {};

  if (!hom_id || !decision) {
    return { error: 'INVALID_HOM', message: 'hom_id and decision required' };
  }

  const escalation = stores.escalationStore.get(hom_id);
  if (!escalation) {
    return { error: 'NOT_FOUND', message: `No pending escalation: ${hom_id}` };
  }

  escalation.status = 'received';
  escalation.decision = decision;
  escalation.resolved_at = new Date().toISOString();
  if (new_bor_version) escalation.new_bor_version = new_bor_version;
  if (clarification) escalation.clarification = clarification;
  stores.escalationStore.update(escalation);

  log('hom_response_received', { hom_id, decision });

  return { status: 'received', hom_id, decision };
}
