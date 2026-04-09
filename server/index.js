/**
 * Arbiter (#190) — Bill of Rights Guardian
 *
 * Perimeter oracle: "Is this action permitted under the Bill of Rights?"
 * Three determinations: IN_SCOPE, OUT_OF_SCOPE, AMBIGUOUS.
 * Access restricted to Nomos and Human Principal.
 *
 * Boot sequence:
 *   1. Load and verify BoR document
 *   2. Register BoR hash in Graph (if not already registered)
 *   3. Create clause matcher (LLM agent)
 *   4. Create in-memory stores (determinations, escalations, drafts)
 *   5. Boot organ via createOrgan() factory
 */

import { createOrgan } from '@coretex/organ-boot';
import config from './config.js';
import { loadBoR } from '../lib/bor-loader.js';
import { registerBorVersion, verifyBorHash } from '../lib/graph-adapter.js';
import { createClauseMatcher } from '../agents/clause-matcher.js';
import { createDeterminationStore } from '../lib/determination-store.js';
import { createAmbiguityTracker } from '../lib/ambiguity-tracker.js';
import { createScopeRoutes } from './routes/scope.js';
import { createBorRoutes } from './routes/bor.js';
import { createHumanRoutes, createEscalationStore } from './routes/human.js';
import { createAmendmentRoutes, createDraftStore } from './routes/amendments.js';
import { handleDirectedMessage } from '../handlers/spine-commands.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// --- Pre-boot: Load and verify BoR ---

let borState = { loaded: false, version: null, hash: null };

try {
  const bor = await loadBoR(config.borPath);
  borState = { loaded: true, version: bor.version, hash: bor.hash, clauseCount: bor.clauseCount };
  log('bor_loaded', { version: bor.version, hash: bor.hash, clause_count: bor.clauseCount });

  // Verify or register hash with Graph
  const verification = await verifyBorHash(config.graphUrl, bor.hash);
  if (verification.registered === null) {
    // First boot or no registered version — register current hash
    const urn = await registerBorVersion(config.graphUrl, {
      version: bor.version,
      hash: bor.hash,
      clauseCount: bor.clauseCount,
    });
    log('bor_initial_registration', { urn });
  } else if (verification.mismatch) {
    log('bor_hash_mismatch_at_boot', {
      expected: verification.registered.hash,
      actual: bor.hash,
      message: 'Starting in DEGRADED mode — all scope queries will return AMBIGUOUS',
    });
    borState.degraded = true;
  } else {
    log('bor_hash_verified', { version: bor.version });
  }
} catch (err) {
  log('bor_load_failed', { error: err.message, message: 'Starting in DEGRADED mode' });
  borState.degraded = true;
}

// --- Create components ---

const clauseMatcher = createClauseMatcher(config);
const determinationStore = createDeterminationStore();
const escalationStore = createEscalationStore();
const draftStore = createDraftStore();
const ambiguityTracker = createAmbiguityTracker({ threshold: 3 });

// Wrap evaluateScope to also record AMBIGUOUS patterns
async function evaluateScope(params) {
  const result = await clauseMatcher.evaluate(params);

  if (result.determination === 'AMBIGUOUS') {
    ambiguityTracker.record({
      action: params.action,
      ap_ref: params.ap_ref || 'unknown',
      cited_clauses: result.cited_clauses,
    });
  }

  return result;
}

// Shared stores for Spine handlers
const stores = { determinationStore, escalationStore, draftStore, ambiguityTracker };

let spineRef = null;

// --- Boot organ ---

const organ = await createOrgan({
  name: config.name,
  port: config.port,
  binding: config.binding,
  spineUrl: config.spineUrl,

  dependencies: ['Spine', 'Graph'],

  routes: (app) => {
    app.use(createScopeRoutes({ config, determinationStore, evaluateScope }));
    app.use(createBorRoutes({ config }));
    app.use(createHumanRoutes({ config, escalationStore }));
    app.use(createAmendmentRoutes({ config, escalationStore, draftStore }));
  },

  onMessage: async (envelope) => handleDirectedMessage(envelope, {
    config, stores, spineRef: () => spineRef,
  }),

  onBroadcast: async (envelope) => {
    const eventType = envelope.payload?.event_type || envelope.event_type;

    switch (eventType) {
      case 'bor_updated': {
        // BoR document has been modified — reload and re-verify
        log('bor_update_notification', { source: envelope.source_organ });
        try {
          const bor = await loadBoR(config.borPath);
          const verification = await verifyBorHash(config.graphUrl, bor.hash);
          borState = {
            loaded: true,
            version: bor.version,
            hash: bor.hash,
            clauseCount: bor.clauseCount,
            degraded: verification.mismatch,
          };
          log('bor_reloaded', { version: bor.version, hash_verified: !verification.mismatch });
        } catch (err) {
          log('bor_reload_failed', { error: err.message });
        }
        break;
      }

      case 'governance_notification': {
        log('governance_notification_received', {
          source: envelope.source_organ,
          type: envelope.payload?.notification_type,
        });
        break;
      }

      default:
        break;
    }
  },

  subscriptions: [
    { event_type: 'bor_updated' },
    { event_type: 'governance_notification' },
  ],

  healthCheck: async () => ({
    bor_loaded: borState.loaded,
    bor_version: borState.version,
    bor_degraded: borState.degraded || false,
    clause_matcher_available: clauseMatcher.isAvailable(),
  }),

  introspectCheck: async () => {
    const detStats = determinationStore.getStats();
    const escStats = escalationStore.getStats();
    const draftStats = draftStore.getStats();
    const ambStats = ambiguityTracker.getStats();
    return {
      pending_escalations: escStats.pending,
      total_determinations: detStats.total_determinations,
      ambiguity_rate: detStats.ambiguity_rate,
      amendment_drafts: draftStats.total_drafts,
      ambiguity_patterns: ambStats.tracked_patterns,
    };
  },

  onStartup: async ({ spine }) => {
    spineRef = spine;
    log('arbiter_spine_connected', { spine_url: config.spineUrl });
  },

  onShutdown: async () => {
    log('arbiter_shutting_down', {
      total_determinations: determinationStore.getStats().total_determinations,
      pending_escalations: escalationStore.getStats().pending,
    });
  },
});
