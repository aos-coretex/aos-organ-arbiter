/**
 * Tracks repeated AMBIGUOUS determinations to identify patterns
 * that may warrant BoR amendment proposals.
 *
 * When the same action category triggers AMBIGUOUS multiple times,
 * Arbiter can draft a non-binding amendment proposal for the human principal.
 *
 * Thresholds:
 *   - 3+ AMBIGUOUS determinations with similar action descriptions → triggers proposal suggestion
 *   - Similarity is coarse (keyword overlap), not LLM-powered
 *
 * This is advisory-only. Proposals are never auto-generated or auto-enacted.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

const DEFAULT_THRESHOLD = 3;

/**
 * Create an ambiguity pattern tracker.
 * @param {{ threshold?: number }} opts
 */
export function createAmbiguityTracker(opts = {}) {
  const threshold = opts.threshold || DEFAULT_THRESHOLD;

  /** @type {Map<string, { actions: string[], count: number, first_seen: string, last_seen: string }>} */
  const patterns = new Map();

  /**
   * Extract coarse category from an action description.
   * Uses keyword normalization — not LLM-powered.
   */
  function categorize(action) {
    return action
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .sort()
      .join(' ');
  }

  return {
    /**
     * Record an AMBIGUOUS determination for pattern tracking.
     * @param {{ action: string, ap_ref: string, cited_clauses: array }} determination
     * @returns {{ threshold_reached: boolean, pattern_key: string, count: number }}
     */
    record(determination) {
      const key = categorize(determination.action);
      if (!key) return { threshold_reached: false, pattern_key: '', count: 0 };

      const existing = patterns.get(key) || {
        actions: [],
        count: 0,
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
      };

      existing.actions.push(determination.action);
      existing.count += 1;
      existing.last_seen = new Date().toISOString();
      patterns.set(key, existing);

      const threshold_reached = existing.count >= threshold;

      if (threshold_reached) {
        log('ambiguity_threshold_reached', {
          pattern_key: key,
          count: existing.count,
          threshold,
          sample_action: determination.action,
        });
      }

      return { threshold_reached, pattern_key: key, count: existing.count };
    },

    /**
     * Get all patterns that have reached the threshold.
     * @returns {Array<{ pattern_key: string, count: number, actions: string[], first_seen: string, last_seen: string }>}
     */
    getThresholdPatterns() {
      return [...patterns.entries()]
        .filter(([_, p]) => p.count >= threshold)
        .map(([key, p]) => ({ pattern_key: key, ...p }));
    },

    /**
     * Get all tracked patterns (for introspection).
     */
    getAll() {
      return [...patterns.entries()].map(([key, p]) => ({ pattern_key: key, ...p }));
    },

    /** Get statistics. */
    getStats() {
      const all = [...patterns.values()];
      return {
        tracked_patterns: all.length,
        threshold_patterns: all.filter(p => p.count >= threshold).length,
        total_ambiguous: all.reduce((sum, p) => sum + p.count, 0),
      };
    },
  };
}
