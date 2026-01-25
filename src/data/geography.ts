/**
 * AWWV Geography Data Module
 * 
 * Provides type-safe access to settlements and municipalities
 * from the unified awwv_geography.geojson file
 */

// Import the unified geography data
import geographyData from '../data/awwv_geography.geojson';

// ============================================================================
// Type Definitions
// ============================================================================

export interface SettlementProperties {
  sid: string;              // Settlement ID
  mid: string;              // Municipality ID (parent)
  feature_type: 'settlement';
  level: 'settlement';
}

export interface MunicipalityProperties {
  mid: string;              // Municipality ID
  municipality_id: string;  // Same as mid
  num_settlements: number;  // Number of settlements in this municipality
  total_area_pixels: number;// Total area in pixels²
  geometry_type: 'MultiPolygon';
  feature_type: 'municipality';
  level: 'municipality';
}

export interface SettlementFeature {
  type: 'Feature';
  properties: SettlementProperties;
  geometry: {
    type: 'Polygon';
    coordinates: number[][][];
  };
}

export interface MunicipalityFeature {
  type: 'Feature';
  properties: MunicipalityProperties;
  geometry: {
    type: 'MultiPolygon';
    coordinates: number[][][][];
  };
}

export type GeographyFeature = SettlementFeature | MunicipalityFeature;

export interface GeographyCollection {
  type: 'FeatureCollection';
  crs: {
    type: 'name';
    properties: {
      name: string;
    };
  };
  metadata: {
    description: string;
    total_features: number;
    settlement_count: number;
    municipality_count: number;
    coordinate_system: string;
    generated: string;
  };
  features: GeographyFeature[];
}

// ============================================================================
// Core Data Access
// ============================================================================

const geography = geographyData as GeographyCollection;

/**
 * Get all settlement features
 */
export function getAllSettlements(): SettlementFeature[] {
  return geography.features.filter(
    (f): f is SettlementFeature => f.properties.feature_type === 'settlement'
  );
}

/**
 * Get all municipality features
 */
export function getAllMunicipalities(): MunicipalityFeature[] {
  return geography.features.filter(
    (f): f is MunicipalityFeature => f.properties.feature_type === 'municipality'
  );
}

/**
 * Get a specific settlement by ID
 */
export function getSettlementById(sid: string): SettlementFeature | undefined {
  return getAllSettlements().find(s => s.properties.sid === sid);
}

/**
 * Get a specific municipality by ID
 */
export function getMunicipalityById(mid: string): MunicipalityFeature | undefined {
  return getAllMunicipalities().find(m => m.properties.mid === mid);
}

// ============================================================================
// Relationship Queries
// ============================================================================

/**
 * Get all settlements within a specific municipality
 */
export function getSettlementsInMunicipality(mid: string): SettlementFeature[] {
  return getAllSettlements().filter(s => s.properties.mid === mid);
}

/**
 * Get the parent municipality for a settlement
 */
export function getMunicipalityForSettlement(sid: string): MunicipalityFeature | undefined {
  const settlement = getSettlementById(sid);
  if (!settlement) return undefined;
  return getMunicipalityById(settlement.properties.mid);
}

/**
 * Group settlements by municipality
 */
export function groupSettlementsByMunicipality(): Map<string, SettlementFeature[]> {
  const grouped = new Map<string, SettlementFeature[]>();
  
  for (const settlement of getAllSettlements()) {
    const mid = settlement.properties.mid;
    if (!grouped.has(mid)) {
      grouped.set(mid, []);
    }
    grouped.get(mid)!.push(settlement);
  }
  
  return grouped;
}

// ============================================================================
// Statistics & Metadata
// ============================================================================

/**
 * Get total number of settlements
 */
export function getTotalSettlements(): number {
  return geography.metadata.settlement_count;
}

/**
 * Get total number of municipalities
 */
export function getTotalMunicipalities(): number {
  return geography.metadata.municipality_count;
}

/**
 * Get municipality statistics
 */
export function getMunicipalityStats(mid: string) {
  const municipality = getMunicipalityById(mid);
  if (!municipality) return null;
  
  return {
    id: municipality.properties.mid,
    settlements: municipality.properties.num_settlements,
    area: municipality.properties.total_area_pixels,
    polygons: municipality.geometry.coordinates.length
  };
}

/**
 * Get all municipalities sorted by size (settlement count)
 */
export function getMunicipalitiesBySize(descending: boolean = true): MunicipalityFeature[] {
  const municipalities = getAllMunicipalities();
  return municipalities.sort((a, b) => {
    const diff = a.properties.num_settlements - b.properties.num_settlements;
    return descending ? -diff : diff;
  });
}

/**
 * Get all municipalities sorted by area
 */
export function getMunicipalitiesByArea(descending: boolean = true): MunicipalityFeature[] {
  const municipalities = getAllMunicipalities();
  return municipalities.sort((a, b) => {
    const diff = a.properties.total_area_pixels - b.properties.total_area_pixels;
    return descending ? -diff : diff;
  });
}

// ============================================================================
// Spatial Utilities
// ============================================================================

/**
 * Get bounding box for a feature
 */
export function getBoundingBox(feature: GeographyFeature): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  const processCoordinates = (coords: any[]): void => {
    for (const item of coords) {
      if (Array.isArray(item[0])) {
        processCoordinates(item);
      } else {
        const [x, y] = item;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  };
  
  processCoordinates(feature.geometry.coordinates);
  
  return { minX, minY, maxX, maxY };
}

/**
 * Get the global bounding box for all geography data
 */
export function getGlobalBounds(): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  for (const feature of geography.features) {
    const bounds = getBoundingBox(feature);
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }
  
  return { minX, minY, maxX, maxY };
}

// ============================================================================
// Filter Utilities
// ============================================================================

/**
 * Filter municipalities by settlement count range
 */
export function getMunicipalitiesBySettlementRange(
  min: number,
  max: number
): MunicipalityFeature[] {
  return getAllMunicipalities().filter(
    m => m.properties.num_settlements >= min && m.properties.num_settlements <= max
  );
}

/**
 * Get municipality size categories
 */
export function getMunicipalitiesByCategory() {
  const municipalities = getAllMunicipalities();
  
  return {
    verySmall: municipalities.filter(m => m.properties.num_settlements <= 10),
    small: municipalities.filter(m => m.properties.num_settlements > 10 && m.properties.num_settlements <= 30),
    medium: municipalities.filter(m => m.properties.num_settlements > 30 && m.properties.num_settlements <= 60),
    large: municipalities.filter(m => m.properties.num_settlements > 60 && m.properties.num_settlements <= 100),
    veryLarge: municipalities.filter(m => m.properties.num_settlements > 100)
  };
}

// ============================================================================
// Export the raw data for advanced use cases
// ============================================================================

export const geographyRaw = geography;

/**
 * Example Usage:
 * 
 * import {
 *   getAllSettlements,
 *   getAllMunicipalities,
 *   getSettlementsInMunicipality,
 *   getMunicipalityById
 * } from './geography';
 * 
 * // Get all settlements
 * const settlements = getAllSettlements();
 * console.log(`Total settlements: ${settlements.length}`);
 * 
 * // Get settlements in a specific municipality
 * const sarajevoSettlements = getSettlementsInMunicipality('10529');
 * console.log(`Sarajevo has ${sarajevoSettlements.length} settlements`);
 * 
 * // Get municipality info
 * const sarajevo = getMunicipalityById('10529');
 * console.log(`Area: ${sarajevo?.properties.total_area_pixels} px²`);
 * 
 * // Get largest municipalities
 * const largest = getMunicipalitiesBySize().slice(0, 10);
 * largest.forEach(m => {
 *   console.log(`${m.properties.mid}: ${m.properties.num_settlements} settlements`);
 * });
 */
