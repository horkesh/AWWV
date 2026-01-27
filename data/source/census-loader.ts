/**
 * A War Without Victory - Census Data Loader
 * 
 * Utilities for loading and parsing the 1991 census data
 * from the compact JSON format.
 */

import {
  SettlementId,
  MunicipalityId,
  CensusData1991,
  PopulationState,
  SettlementState,
  SettlementRegistry,
  emptyDelta,
  FactionId
} from './settlement';

// ============================================
// COMPACT JSON FORMAT TYPES
// ============================================

/**
 * Compact settlement record from JSON
 * [total, bosniaks, croats, serbs, others]
 */
type CompactPopulation = [number, number, number, number, number];

interface CompactSettlement {
  n: string;  // name
  m: string;  // municipality ID
  p: CompactPopulation;  // population
}

interface CompactMunicipality {
  n: string;  // name
  s: string[];  // settlement IDs
  p: CompactPopulation;  // aggregated population
}

interface CompactCensusData {
  metadata: {
    description: string;
    source: string;
    total_population: number;
    settlement_count: number;
    municipality_count: number;
  };
  municipalities: Record<string, CompactMunicipality>;
  settlements: Record<string, CompactSettlement>;
}

// ============================================
// PARSING UTILITIES
// ============================================

/**
 * Convert compact population array to PopulationState
 */
function parsePopulation(compact: CompactPopulation): PopulationState {
  return {
    total: compact[0],
    bosniaks: compact[1],
    croats: compact[2],
    serbs: compact[3],
    others: compact[4]
  };
}

/**
 * Load and parse census data from compact JSON
 */
export async function loadCensusData(jsonPath: string): Promise<Map<SettlementId, CensusData1991>> {
  const response = await fetch(jsonPath);
  const data: CompactCensusData = await response.json();
  
  const census = new Map<SettlementId, CensusData1991>();
  
  for (const [settlementId, compact] of Object.entries(data.settlements)) {
    const munId = compact.m;
    const munData = data.municipalities[munId];
    
    census.set(settlementId, {
      id: settlementId,
      name: compact.n,
      municipalityId: munId,
      municipalityName: munData?.n ?? `Municipality ${munId}`,
      population: parsePopulation(compact.p)
    });
  }
  
  return census;
}

/**
 * Load census data synchronously (for Node.js or bundled data)
 */
export function loadCensusDataSync(data: CompactCensusData): Map<SettlementId, CensusData1991> {
  const census = new Map<SettlementId, CensusData1991>();
  
  for (const [settlementId, compact] of Object.entries(data.settlements)) {
    const munId = compact.m;
    const munData = data.municipalities[munId];
    
    census.set(settlementId, {
      id: settlementId,
      name: compact.n,
      municipalityId: munId,
      municipalityName: munData?.n ?? `Municipality ${munId}`,
      population: parsePopulation(compact.p)
    });
  }
  
  return census;
}

// ============================================
// REGISTRY INITIALIZATION
// ============================================

/**
 * Initialize the settlement registry from census data
 */
export function initializeRegistry(
  census: Map<SettlementId, CensusData1991>
): SettlementRegistry {
  const registry: SettlementRegistry = {
    census,
    state: new Map(),
    byMunicipality: new Map(),
    byFaction: new Map()
  };
  
  // Initialize faction maps
  const factions: FactionId[] = ['arbih', 'vrs', 'hvo', 'jna', 'neutral'];
  for (const faction of factions) {
    registry.byFaction.set(faction, new Set());
  }
  
  // Process each settlement
  for (const [settlementId, censusData] of census) {
    // Initialize settlement state
    const state: SettlementState = {
      id: settlementId,
      currentPopulation: { ...censusData.population },
      populationDelta: emptyDelta(),
      controllingFaction: null,
      authorityState: 'consolidated',  // Initial state before war
      supplyState: 'adequate',
      assignedBrigade: null,
      controlChangedTurn: null,
      isContested: false
    };
    registry.state.set(settlementId, state);
    
    // Index by municipality
    const munId = censusData.municipalityId;
    if (!registry.byMunicipality.has(munId)) {
      registry.byMunicipality.set(munId, []);
    }
    registry.byMunicipality.get(munId)!.push(settlementId);
  }
  
  return registry;
}

// ============================================
// QUERY UTILITIES
// ============================================

/**
 * Get total population for a municipality
 */
export function getMunicipalityPopulation(
  registry: SettlementRegistry,
  municipalityId: MunicipalityId
): PopulationState {
  const settlementIds = registry.byMunicipality.get(municipalityId) ?? [];
  
  const total: PopulationState = {
    total: 0,
    bosniaks: 0,
    croats: 0,
    serbs: 0,
    others: 0
  };
  
  for (const id of settlementIds) {
    const state = registry.state.get(id);
    if (state) {
      total.total += state.currentPopulation.total;
      total.bosniaks += state.currentPopulation.bosniaks;
      total.croats += state.currentPopulation.croats;
      total.serbs += state.currentPopulation.serbs;
      total.others += state.currentPopulation.others;
    }
  }
  
  return total;
}

/**
 * Get settlements controlled by a faction
 */
export function getSettlementsByFaction(
  registry: SettlementRegistry,
  faction: FactionId
): SettlementId[] {
  return Array.from(registry.byFaction.get(faction) ?? []);
}

/**
 * Get total population under faction control
 */
export function getFactionPopulation(
  registry: SettlementRegistry,
  faction: FactionId
): PopulationState {
  const settlementIds = registry.byFaction.get(faction) ?? new Set();
  
  const total: PopulationState = {
    total: 0,
    bosniaks: 0,
    croats: 0,
    serbs: 0,
    others: 0
  };
  
  for (const id of settlementIds) {
    const state = registry.state.get(id);
    if (state) {
      total.total += state.currentPopulation.total;
      total.bosniaks += state.currentPopulation.bosniaks;
      total.croats += state.currentPopulation.croats;
      total.serbs += state.currentPopulation.serbs;
      total.others += state.currentPopulation.others;
    }
  }
  
  return total;
}

/**
 * Update faction control for a settlement
 */
export function updateSettlementControl(
  registry: SettlementRegistry,
  settlementId: SettlementId,
  newFaction: FactionId | null,
  turn: number
): void {
  const state = registry.state.get(settlementId);
  if (!state) return;
  
  const oldFaction = state.controllingFaction;
  
  // Remove from old faction set
  if (oldFaction) {
    registry.byFaction.get(oldFaction)?.delete(settlementId);
  }
  
  // Add to new faction set
  if (newFaction) {
    registry.byFaction.get(newFaction)?.add(settlementId);
  }
  
  // Update state
  state.controllingFaction = newFaction;
  state.controlChangedTurn = turn;
}

// ============================================
// STATISTICS
// ============================================

export interface CensusStatistics {
  totalPopulation: number;
  settlementCount: number;
  municipalityCount: number;
  populationByEthnicity: PopulationState;
  largestSettlements: Array<{ id: SettlementId; name: string; population: number }>;
  largestMunicipalities: Array<{ id: MunicipalityId; name: string; population: number }>;
}

/**
 * Calculate overall census statistics
 */
export function getCensusStatistics(
  registry: SettlementRegistry,
  topN: number = 10
): CensusStatistics {
  const stats: CensusStatistics = {
    totalPopulation: 0,
    settlementCount: registry.census.size,
    municipalityCount: registry.byMunicipality.size,
    populationByEthnicity: {
      total: 0,
      bosniaks: 0,
      croats: 0,
      serbs: 0,
      others: 0
    },
    largestSettlements: [],
    largestMunicipalities: []
  };
  
  // Calculate totals and find largest settlements
  const settlementPops: Array<{ id: SettlementId; name: string; population: number }> = [];
  
  for (const [id, census] of registry.census) {
    stats.totalPopulation += census.population.total;
    stats.populationByEthnicity.bosniaks += census.population.bosniaks;
    stats.populationByEthnicity.croats += census.population.croats;
    stats.populationByEthnicity.serbs += census.population.serbs;
    stats.populationByEthnicity.others += census.population.others;
    
    settlementPops.push({
      id,
      name: census.name,
      population: census.population.total
    });
  }
  
  stats.populationByEthnicity.total = stats.totalPopulation;
  
  // Sort and get top settlements
  settlementPops.sort((a, b) => b.population - a.population);
  stats.largestSettlements = settlementPops.slice(0, topN);
  
  // Calculate municipality totals
  const munPops: Array<{ id: MunicipalityId; name: string; population: number }> = [];
  
  for (const [munId, settlementIds] of registry.byMunicipality) {
    let munPop = 0;
    let munName = '';
    
    for (const sId of settlementIds) {
      const census = registry.census.get(sId);
      if (census) {
        munPop += census.population.total;
        if (!munName) munName = census.municipalityName;
      }
    }
    
    munPops.push({ id: munId, name: munName, population: munPop });
  }
  
  munPops.sort((a, b) => b.population - a.population);
  stats.largestMunicipalities = munPops.slice(0, topN);
  
  return stats;
}
