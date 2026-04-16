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
import { createGraphClient } from '@coretex/organ-boot/graph-client';
import { createLoader } from '@coretex/organ-boot/llm-settings-loader';
import { initializeUsageAttribution } from '@coretex/organ-boot/usage-attribution';
import { stat } from 'node:fs/promises';
import config from './config.js';
import { loadBoR, createGovernanceLoaders } from '../lib/bor-loader.js';
import { registerBorVersion, verifyBorHash } from '../lib/graph-adapter.js';
import { createClauseMatcher } from '../agents/clause-matcher.js';
import { matchConstitutional, matchScope } from '../agents/governance-matchers.js';
import { createDeterminationStore } from '../lib/determination-store.js';
import { createAmbiguityTracker } from '../lib/ambiguity-tracker.js';
import { createScopeRoutes } from './routes/scope.js';
import { createConstitutionalCheckRoutes } from './routes/constitutional-check.js';
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
  const fileStat = await stat(config.borPath);
  borState = {
    loaded: true,
    version: bor.version,
    hash: bor.hash,
    clauseCount: bor.clauseCount,
    raw: bor.raw,
    effectiveSince: fileStat.mtime.toISOString(),
    loadedAt: new Date().toISOString(),
  };
  log('bor_loaded', { version: bor.version, hash: bor.hash, clause_count: bor.clauseCount });

  // Verify or register hash with Graph
  const verification = await verifyBorHash(config.graphUrl, bor.version, bor.hash);
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

// --- LLM settings loader (MP-CONFIG-1 R5 migration — l9m-5) ---

const llmLoader = createLoader({
  organNumber: 190,
  organName: 'arbiter',
  settingsRoot: config.settingsRoot,
});

function buildLlmClient(agentName) {
  const { config: resolved, chat } = llmLoader.resolveWithCascade(agentName);
  const apiKeyEnv = resolved.apiKeyEnvVar || 'ANTHROPIC_API_KEY';
  return {
    chat,
    isAvailable: () => Boolean(process.env[apiKeyEnv]),
    getUsage: () => ({ agent: resolved.agentName, model: resolved.defaultModel, provider: resolved.defaultProvider }),
  };
}

// MP-CONFIG-1 R9 — register the process-default usage writer so every
// cascade-wrapped `llm.chat()` emits a flat `llm_usage_event` concept
// into Graph, bound to the tenant entity (infrastructure-exempt audit).
initializeUsageAttribution({ organName: 'Arbiter', graphUrl: config.graphUrl });

// --- Create components ---

const clauseMatcher = createClauseMatcher(config, buildLlmClient('clause-matcher'));
const determinationStore = createDeterminationStore();
const escalationStore = createEscalationStore();
const draftStore = createDraftStore();
const ambiguityTracker = createAmbiguityTracker({ threshold: 3 });

// Graph-backed governance loaders (MP-17).
const graphClient = createGraphClient({ baseUrl: config.graphUrl, organName: 'Arbiter' });
const governanceLoaders = createGovernanceLoaders({ graphClient, ttlMs: 60_000 });

// Matcher wrappers with ambiguity tracking preserved for AMBIGUOUS / INDETERMINATE.
async function wrappedMatchConstitutional(params) {
  const result = await matchConstitutional({ ...params, clauseMatcher });
  if (result.verdict === 'INDETERMINATE') {
    ambiguityTracker.record({
      action: params.action,
      ap_ref: 'constitutional-check',
      cited_clauses: result.matched_rules.map((id) => ({ clause_id: id })),
    });
  }
  return result;
}

async function wrappedMatchScope(params) {
  const result = await matchScope({ ...params, clauseMatcher });
  if (result.verdict === 'AMBIGUOUS') {
    ambiguityTracker.record({
      action: params.action,
      ap_ref: 'scope-query',
      cited_clauses: result.matched_rules.map((id) => ({ clause_id: id })),
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
    app.use(createScopeRoutes({
      governanceLoaders,
      determinationStore,
      matchConstitutional: wrappedMatchConstitutional,
      matchScope: wrappedMatchScope,
    }));
    app.use(createConstitutionalCheckRoutes({
      governanceLoaders,
      matchConstitutional: wrappedMatchConstitutional,
    }));
    app.use(createBorRoutes({ config, borState }));
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
        // BoR document has been modified — reload and re-verify.
        // Mutate borState in place so the router's captured reference stays valid.
        log('bor_update_notification', { source: envelope.source_organ });
        try {
          const bor = await loadBoR(config.borPath);
          const fileStat = await stat(config.borPath);
          const verification = await verifyBorHash(config.graphUrl, bor.version, bor.hash);
          Object.assign(borState, {
            loaded: true,
            version: bor.version,
            hash: bor.hash,
            clauseCount: bor.clauseCount,
            raw: bor.raw,
            effectiveSince: fileStat.mtime.toISOString(),
            loadedAt: new Date().toISOString(),
            degraded: verification.mismatch,
          });
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

      case 'governance_updated': {
        // MP-17: Senate broadcasts after publishing Constitution / entity BoR / MSP / statute.
        // Invalidate the corresponding cache entry so the next query reads fresh from Graph.
        const urn = envelope.payload?.data?.urn || envelope.payload?.urn;
        log('governance_updated_received', { source: envelope.source_organ, urn });
        governanceLoaders.invalidate(urn);
        break;
      }

      default:
        break;
    }
  },

  subscriptions: [
    { event_type: 'bor_updated' },
    { event_type: 'governance_notification' },
    { event_type: 'governance_updated' },
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
      // MP-CONFIG-1 R5 — flat per bug #9; consumed by Axon aggregator R8.
      llm: llmLoader.introspect(),
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
