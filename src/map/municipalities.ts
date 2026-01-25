import { loadSettlementGraph } from './settlements.js';

/**
 * Returns a deterministic set of valid municipality IDs (mun_code values) from settlements.
 * Used for validation and CLI operations.
 */
export async function getValidMunicipalityIds(): Promise<Set<string>> {
  const graph = await loadSettlementGraph();
  const munCodes = new Set<string>();
  for (const settlement of graph.settlements.values()) {
    if (settlement.mun_code && typeof settlement.mun_code === 'string' && settlement.mun_code.length > 0) {
      munCodes.add(settlement.mun_code);
    }
  }
  return munCodes;
}
