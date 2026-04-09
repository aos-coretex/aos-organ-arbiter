/**
 * In-memory determination store — tracks scope query results.
 *
 * Determinations are ephemeral within the organ's lifetime.
 * They are also published to Collective Memory via Spine OTM
 * for long-term persistence (handled in relay a8j-5).
 *
 * The store enables:
 *   - GET /determinations audit trail
 *   - Repeated AMBIGUOUS pattern detection (relay a8j-4)
 *   - /introspect statistics (total_determinations, ambiguity_rate)
 */

/**
 * @typedef {{
 *   ap_ref: string,
 *   determination: 'IN_SCOPE' | 'OUT_OF_SCOPE' | 'AMBIGUOUS',
 *   cited_clauses: Array<{ clause_id: string, text_ref: string, relevance: string }>,
 *   bor_version: string,
 *   bor_hash: string,
 *   confidence: number,
 *   reasoning: string,
 *   timestamp: string,
 *   requester: string
 * }} Determination
 */

export function createDeterminationStore() {
  /** @type {Determination[]} */
  const records = [];

  return {
    /**
     * Record a new determination.
     * @param {Determination} determination
     */
    add(determination) {
      records.push({
        ...determination,
        timestamp: determination.timestamp || new Date().toISOString(),
      });
    },

    /**
     * Query determinations with optional filters.
     * @param {{ ap_ref?: string, determination?: string, since?: string, limit?: number }} filters
     * @returns {{ determinations: Determination[], count: number }}
     */
    query(filters = {}) {
      let result = [...records];

      if (filters.ap_ref) {
        result = result.filter(d => d.ap_ref === filters.ap_ref);
      }
      if (filters.determination) {
        result = result.filter(d => d.determination === filters.determination);
      }
      if (filters.since) {
        const since = new Date(filters.since).getTime();
        result = result.filter(d => new Date(d.timestamp).getTime() >= since);
      }

      // Most recent first
      result.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      const limit = filters.limit || 50;
      return {
        determinations: result.slice(0, limit),
        count: result.length,
      };
    },

    /**
     * Get statistics for /introspect.
     * @returns {{ total_determinations: number, ambiguity_rate: number, by_type: object }}
     */
    getStats() {
      const total = records.length;
      const ambiguous = records.filter(d => d.determination === 'AMBIGUOUS').length;
      const byType = {
        IN_SCOPE: records.filter(d => d.determination === 'IN_SCOPE').length,
        OUT_OF_SCOPE: records.filter(d => d.determination === 'OUT_OF_SCOPE').length,
        AMBIGUOUS: ambiguous,
      };
      return {
        total_determinations: total,
        ambiguity_rate: total > 0 ? ambiguous / total : 0,
        by_type: byType,
      };
    },

    /** Get all records (for amendment pattern detection in relay a8j-4). */
    getAll() {
      return [...records];
    },
  };
}
