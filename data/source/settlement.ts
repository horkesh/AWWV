/**
 * A War Without Victory - Settlement and Population Type Definitions
 * 
 * Core data structures for tracking settlement-level population throughout the game.
 * These types are designed to support:
 * - 1991 baseline census data
 * - Dynamic population changes during gameplay
 * - Ethnic demographic tracking
 * - Integration with the spatial/control systems
 */

// ============================================
// ETHNIC DEMOGRAPHICS
// ============================================

/**
 * Ethnic group identifiers as used in the 1991 census
 */
export type EthnicGroup = 'bosniaks' | 'croats' | 'serbs' | 'others';

/**
 * Population breakdown by ethnic group
 * All values are absolute counts, not percentages
 */
export interface EthnicBreakdown {
  /** Bosniaks (Muslims in 1991 census terminology) */
  bosniaks: number;
  /** Croats */
  croats: number;
  /** Serbs */
  serbs: number;
  /** Others (Yugoslavs, Roma, other minorities, undeclared) */
  others: number;
}

/**
 * Complete population state including total and ethnic breakdown
 */
export interface PopulationState extends EthnicBreakdown {
  /** Total population - should equal sum of ethnic groups */
  total: number;
}

// ============================================
// SETTLEMENT IDENTIFIERS
// ============================================

/**
 * Unique settlement identifier (from census data)
 * Format: 6-digit numeric string (e.g., "100013", "200018")
 */
export type SettlementId = string;

/**
 * Unique municipality identifier
 * Format: 5-digit numeric string (e.g., "10014", "20010")
 */
export type MunicipalityId = string;

// ============================================
// BASELINE CENSUS DATA (IMMUTABLE)
// ============================================

/**
 * 1991 census data for a settlement - this is immutable reference data
 */
export interface CensusData1991 {
  /** Settlement ID */
  readonly id: SettlementId;
  /** Settlement name (in local language) */
  readonly name: string;
  /** Parent municipality ID */
  readonly municipalityId: MunicipalityId;
  /** Parent municipality name */
  readonly municipalityName: string;
  /** 1991 population - never modified during gameplay */
  readonly population: Readonly<PopulationState>;
}

// ============================================
// DYNAMIC SETTLEMENT STATE (MUTABLE)
// ============================================

/**
 * Population change tracking - records how population has changed
 */
export interface PopulationDelta {
  /** Casualties from military action */
  casualties: PopulationState;
  /** Displaced/fled population */
  displaced: PopulationState;
  /** Refugees arrived from other settlements */
  refugees: PopulationState;
  /** Returns (displaced people returning) */
  returns: PopulationState;
}

/**
 * Current settlement state during gameplay
 */
export interface SettlementState {
  /** Settlement ID */
  id: SettlementId;
  
  /** 
   * Current population - derived from baseline + changes
   * Recalculated each turn from census baseline and accumulated deltas
   */
  currentPopulation: PopulationState;
  
  /**
   * Accumulated population changes since game start
   * Used to calculate current population: baseline + (refugees + returns) - (casualties + displaced)
   */
  populationDelta: PopulationDelta;
  
  /**
   * Controlling faction (if any)
   * null = no clear control
   */
  controllingFaction: FactionId | null;
  
  /**
   * Authority state within the settlement
   */
  authorityState: AuthorityState;
  
  /**
   * Supply state affecting the settlement
   */
  supplyState: SupplyState;
  
  /**
   * Brigade responsible for this settlement (AoR assignment)
   */
  assignedBrigade: BrigadeId | null;
  
  /**
   * Turn number when control last changed
   * Used for stabilization calculations
   */
  controlChangedTurn: number | null;
  
  /**
   * Whether settlement is currently contested (opposing forces present)
   */
  isContested: boolean;
}

// ============================================
// SUPPORTING TYPES
// ============================================

export type FactionId = 'arbih' | 'vrs' | 'hvo' | 'jna' | 'neutral';
export type BrigadeId = string;

export type AuthorityState = 
  | 'consolidated'    // Stable governance
  | 'contested'       // Authority disputed
  | 'fragmented'      // No effective governance
  | 'occupied';       // Military control only

export type SupplyState = 
  | 'adequate'        // Full supply
  | 'strained'        // Reduced but functional
  | 'critical';       // Severe shortages

// ============================================
// MUNICIPALITY AGGREGATIONS
// ============================================

/**
 * Municipality-level state (aggregated from settlements)
 */
export interface MunicipalityState {
  /** Municipality ID */
  id: MunicipalityId;
  /** Municipality name */
  name: string;
  
  /** All settlements in this municipality */
  settlementIds: SettlementId[];
  
  /** 
   * Aggregated current population (sum of all settlement populations)
   * Derived value - recalculated each turn
   */
  currentPopulation: PopulationState;
  
  /**
   * Control breakdown by faction (percentage of settlements)
   */
  controlBreakdown: Map<FactionId, number>;
  
  /**
   * Whether municipality has fragmented into MCZs
   */
  isFragmented: boolean;
  
  /**
   * Municipal Control Zones (if fragmented)
   */
  controlZones: MunicipalControlZone[];
}

/**
 * Municipal Control Zone - represents a fragment of a municipality
 * when it has split due to conflict
 */
export interface MunicipalControlZone {
  /** MCZ identifier */
  id: string;
  /** Parent municipality */
  municipalityId: MunicipalityId;
  /** Settlements in this zone */
  settlementIds: SettlementId[];
  /** Controlling faction */
  controllingFaction: FactionId;
  /** Zone population */
  population: PopulationState;
}

// ============================================
// LOOKUP STRUCTURES
// ============================================

/**
 * Master settlement registry - indexed for fast lookup
 */
export interface SettlementRegistry {
  /** All census baseline data, indexed by settlement ID */
  census: Map<SettlementId, CensusData1991>;
  
  /** Current game state, indexed by settlement ID */
  state: Map<SettlementId, SettlementState>;
  
  /** Settlements grouped by municipality */
  byMunicipality: Map<MunicipalityId, SettlementId[]>;
  
  /** Settlements grouped by controlling faction */
  byFaction: Map<FactionId, Set<SettlementId>>;
}

// ============================================
// POPULATION CALCULATION UTILITIES
// ============================================

/**
 * Calculate current population from baseline and deltas
 */
export function calculateCurrentPopulation(
  baseline: PopulationState,
  delta: PopulationDelta
): PopulationState {
  const calc = (group: EthnicGroup): number => {
    const base = baseline[group];
    const added = delta.refugees[group] + delta.returns[group];
    const removed = delta.casualties[group] + delta.displaced[group];
    return Math.max(0, base + added - removed);
  };
  
  const result: PopulationState = {
    bosniaks: calc('bosniaks'),
    croats: calc('croats'),
    serbs: calc('serbs'),
    others: calc('others'),
    total: 0
  };
  
  result.total = result.bosniaks + result.croats + result.serbs + result.others;
  return result;
}

/**
 * Create empty population state
 */
export function emptyPopulation(): PopulationState {
  return { total: 0, bosniaks: 0, croats: 0, serbs: 0, others: 0 };
}

/**
 * Create empty population delta
 */
export function emptyDelta(): PopulationDelta {
  return {
    casualties: emptyPopulation(),
    displaced: emptyPopulation(),
    refugees: emptyPopulation(),
    returns: emptyPopulation()
  };
}

/**
 * Sum multiple population states
 */
export function sumPopulations(...populations: PopulationState[]): PopulationState {
  return populations.reduce((acc, pop) => ({
    total: acc.total + pop.total,
    bosniaks: acc.bosniaks + pop.bosniaks,
    croats: acc.croats + pop.croats,
    serbs: acc.serbs + pop.serbs,
    others: acc.others + pop.others
  }), emptyPopulation());
}

/**
 * Get majority ethnic group in a population
 */
export function getMajorityGroup(pop: PopulationState): EthnicGroup | null {
  if (pop.total === 0) return null;
  
  const groups: EthnicGroup[] = ['bosniaks', 'croats', 'serbs', 'others'];
  let maxGroup: EthnicGroup = 'bosniaks';
  let maxCount = pop.bosniaks;
  
  for (const group of groups) {
    if (pop[group] > maxCount) {
      maxCount = pop[group];
      maxGroup = group;
    }
  }
  
  // Return null if no clear majority (less than 50%)
  return maxCount > pop.total * 0.5 ? maxGroup : null;
}

/**
 * Get plurality ethnic group (largest group even if <50%)
 */
export function getPluralityGroup(pop: PopulationState): EthnicGroup | null {
  if (pop.total === 0) return null;
  
  const groups: EthnicGroup[] = ['bosniaks', 'croats', 'serbs', 'others'];
  return groups.reduce((max, group) => 
    pop[group] > pop[max] ? group : max, 'bosniaks');
}
