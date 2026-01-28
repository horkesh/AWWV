import { CURRENT_SCHEMA_VERSION } from './game_state.js';
import { validateState } from '../validate/validate.js';
import { canonicalizePoliticalSideId, defaultArmyLabelForSide, POLITICAL_SIDES } from './identity.js';
export function serializeState(state) {
    assertNoErrors(validateState(state), 'State failed validation before serialize');
    const withVersion = {
        ...state,
        schema_version: CURRENT_SCHEMA_VERSION
    };
    return JSON.stringify(withVersion, null, 2);
}
export function deserializeState(payload) {
    const parsed = JSON.parse(payload);
    const migrated = migrateState(parsed);
    assertNoErrors(validateState(migrated), 'State failed validation after deserialize');
    return migrated;
}
// Kept for convenience in existing callers; now uses the validation framework.
export function validateStateCompat(state) {
    const issues = validateState(state);
    return { ok: issues.every((i) => i.severity !== 'error'), issues };
}
function validateMeta(meta, issues) {
    if (!meta || typeof meta !== 'object') {
        issues.push({ severity: 'error', code: 'meta.missing', path: 'meta', message: 'Missing meta block' });
        return;
    }
    if (!Number.isInteger(meta.turn) || meta.turn < 0) {
        issues.push({ severity: 'error', code: 'meta.turn.invalid', path: 'meta.turn', message: 'turn must be a non-negative integer' });
    }
    if (!meta.seed || typeof meta.seed !== 'string') {
        issues.push({ severity: 'error', code: 'meta.seed.invalid', path: 'meta.seed', message: 'seed must be a non-empty string' });
    }
}
function validateAuthorityProfile(profile, path, issues) {
    if (!profile || typeof profile !== 'object') {
        issues.push({ severity: 'error', code: 'profile.missing', path, message: 'authority profile missing' });
        return;
    }
    const keys = ['authority', 'legitimacy', 'control', 'logistics', 'exhaustion'];
    for (const key of keys) {
        const value = profile[key];
        if (!Number.isFinite(value)) {
            issues.push({ severity: 'error', code: 'profile.value.invalid', path: `${path}.${key}`, message: 'must be a finite number' });
        }
    }
}
function validateFactions(factions, issues) {
    if (!Array.isArray(factions)) {
        issues.push({ severity: 'error', code: 'factions.invalid', path: 'factions', message: 'factions must be an array' });
        return;
    }
    factions.forEach((faction, index) => {
        const basePath = `factions[${index}]`;
        if (!faction || typeof faction !== 'object') {
            issues.push({ severity: 'error', code: 'faction.invalid', path: basePath, message: 'faction must be an object' });
            return;
        }
        if (!faction.id || typeof faction.id !== 'string') {
            issues.push({ severity: 'error', code: 'faction.id.invalid', path: `${basePath}.id`, message: 'id must be a non-empty string' });
        }
        validateAuthorityProfile(faction.profile, `${basePath}.profile`, issues);
        if (!Array.isArray(faction.areasOfResponsibility)) {
            issues.push({
                severity: 'error',
                code: 'faction.aor.invalid',
                path: `${basePath}.areasOfResponsibility`,
                message: 'areasOfResponsibility must be an array'
            });
        }
        else if (!faction.areasOfResponsibility.every((id) => typeof id === 'string')) {
            issues.push({
                severity: 'error',
                code: 'faction.aor.invalid_item',
                path: `${basePath}.areasOfResponsibility`,
                message: 'areasOfResponsibility must contain strings'
            });
        }
        // command_capacity validation (Phase 9)
        const commandCapacity = faction.command_capacity;
        if (commandCapacity !== undefined) {
            if (!Number.isInteger(commandCapacity) || commandCapacity < 0) {
                issues.push({
                    severity: 'error',
                    code: 'faction.command_capacity.invalid',
                    path: `${basePath}.command_capacity`,
                    message: 'command_capacity must be an integer >= 0'
                });
            }
        }
        // negotiation validation (Phase 11A)
        const negotiation = faction.negotiation;
        if (negotiation !== undefined) {
            if (!negotiation || typeof negotiation !== 'object') {
                issues.push({
                    severity: 'error',
                    code: 'faction.negotiation.invalid',
                    path: `${basePath}.negotiation`,
                    message: 'negotiation must be an object'
                });
            }
            else {
                const pressure = negotiation.pressure;
                if (!Number.isInteger(pressure) || pressure < 0) {
                    issues.push({
                        severity: 'error',
                        code: 'faction.negotiation.pressure.invalid',
                        path: `${basePath}.negotiation.pressure`,
                        message: 'negotiation.pressure must be an integer >= 0'
                    });
                }
                const lastChangeTurn = negotiation.last_change_turn;
                if (lastChangeTurn !== null && !Number.isInteger(lastChangeTurn)) {
                    issues.push({
                        severity: 'error',
                        code: 'faction.negotiation.last_change_turn.invalid',
                        path: `${basePath}.negotiation.last_change_turn`,
                        message: 'negotiation.last_change_turn must be null or an integer'
                    });
                }
            }
        }
    });
}
function assertNoErrors(issues, prefix) {
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length === 0)
        return;
    const details = errors
        .map((issue) => `${issue.code}${issue.path ? ` @ ${issue.path}` : ''}: ${issue.message}`)
        .join('; ');
    throw new Error(`${prefix}: ${details}`);
}
function structuredClonePolyfill(input) {
    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(input);
    }
    return JSON.parse(JSON.stringify(input));
}
function migrateState(raw) {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Cannot migrate: state is not an object');
    }
    const candidate = structuredClonePolyfill(raw);
    const version = candidate.schema_version;
    switch (version) {
        case undefined:
        case CURRENT_SCHEMA_VERSION: {
            // Default new fields for older saves.
            if (!('front_segments' in candidate) || candidate.front_segments === undefined) {
                candidate.front_segments = {};
            }
            if (!('formations' in candidate) || candidate.formations === undefined) {
                candidate.formations = {};
            }
            if (!('front_posture' in candidate) || candidate.front_posture === undefined) {
                candidate.front_posture = {};
            }
            if (!('front_posture_regions' in candidate) || candidate.front_posture_regions === undefined) {
                candidate.front_posture_regions = {};
            }
            if (!('front_pressure' in candidate) || candidate.front_pressure === undefined) {
                candidate.front_pressure = {};
            }
            if (!('militia_pools' in candidate) || candidate.militia_pools === undefined) {
                candidate.militia_pools = {};
            }
            // Phase 11B: Default negotiation_status and ceasefire
            if (!('negotiation_status' in candidate) || candidate.negotiation_status === undefined) {
                candidate.negotiation_status = { ceasefire_active: false, ceasefire_since_turn: null, last_offer_turn: null };
            }
            else {
                const ns = candidate.negotiation_status;
                if (typeof ns !== 'object') {
                    candidate.negotiation_status = { ceasefire_active: false, ceasefire_since_turn: null, last_offer_turn: null };
                }
                else {
                    if (typeof ns.ceasefire_active !== 'boolean')
                        ns.ceasefire_active = false;
                    const currentTurn = candidate.meta?.turn ?? 0;
                    if (ns.ceasefire_since_turn !== null && (!Number.isInteger(ns.ceasefire_since_turn) || ns.ceasefire_since_turn > currentTurn)) {
                        ns.ceasefire_since_turn = null;
                    }
                    if (ns.last_offer_turn !== null && (!Number.isInteger(ns.last_offer_turn) || ns.last_offer_turn > currentTurn)) {
                        ns.last_offer_turn = null;
                    }
                }
            }
            if (!('ceasefire' in candidate) || candidate.ceasefire === undefined) {
                candidate.ceasefire = {};
            }
            else {
                // Validate and clean ceasefire entries
                const ceasefire = candidate.ceasefire;
                if (ceasefire && typeof ceasefire === 'object') {
                    const currentTurn = candidate.meta?.turn ?? 0;
                    const keysSorted = Object.keys(ceasefire).sort();
                    for (const edgeId of keysSorted) {
                        const entry = ceasefire[edgeId];
                        if (!entry || typeof entry !== 'object') {
                            delete ceasefire[edgeId];
                            continue;
                        }
                        if (!Number.isInteger(entry.since_turn) || entry.since_turn < 0 || entry.since_turn > currentTurn) {
                            delete ceasefire[edgeId];
                            continue;
                        }
                        if (entry.until_turn !== null && (!Number.isInteger(entry.until_turn) || entry.until_turn < entry.since_turn)) {
                            entry.until_turn = null;
                        }
                        // Remove expired entries
                        if (entry.until_turn !== null && entry.until_turn <= currentTurn) {
                            delete ceasefire[edgeId];
                        }
                    }
                }
            }
            // Ensure deterministic defaulting for new FrontSegmentState fields.
            const segments = candidate.front_segments;
            if (segments && typeof segments === 'object') {
                const segRec = segments;
                const keysSorted = Object.keys(segRec).sort();
                for (const key of keysSorted) {
                    const seg = segRec[key];
                    if (!seg || typeof seg !== 'object')
                        continue;
                    if (!Number.isInteger(seg.active_streak) || seg.active_streak < 0)
                        seg.active_streak = 0;
                    if (!Number.isInteger(seg.max_active_streak) || seg.max_active_streak < 0)
                        seg.max_active_streak = 0;
                    if (!Number.isInteger(seg.friction) || seg.friction < 0)
                        seg.friction = 0;
                    if (!Number.isInteger(seg.max_friction) || seg.max_friction < 0)
                        seg.max_friction = 0;
                }
            }
            // Canonicalize faction IDs and ensure deterministic defaulting for new FactionState fields.
            const factions = candidate.factions;
            if (factions && Array.isArray(factions)) {
                const factionsSorted = [...factions].sort((a, b) => {
                    const idA = a?.id ?? '';
                    const idB = b?.id ?? '';
                    return idA.localeCompare(idB);
                });
                for (const f of factionsSorted) {
                    if (!f || typeof f !== 'object')
                        continue;
                    // Canonicalize faction ID
                    if (typeof f.id === 'string') {
                        f.id = canonicalizePoliticalSideId(f.id);
                    }
                    if (!Array.isArray(f.supply_sources))
                        f.supply_sources = [];
                    if (!Number.isInteger(f.command_capacity) || f.command_capacity < 0)
                        f.command_capacity = 0;
                    // Phase 11A: Default negotiation state
                    if (!f.negotiation || typeof f.negotiation !== 'object') {
                        f.negotiation = { pressure: 0, last_change_turn: null, capital: 0, spent_total: 0, last_capital_change_turn: null };
                    }
                    else {
                        if (!Number.isInteger(f.negotiation.pressure) || f.negotiation.pressure < 0) {
                            f.negotiation.pressure = 0;
                        }
                        const currentTurn = candidate.meta?.turn ?? 0;
                        if (f.negotiation.last_change_turn !== null && (!Number.isInteger(f.negotiation.last_change_turn) || f.negotiation.last_change_turn > currentTurn)) {
                            f.negotiation.last_change_turn = null;
                        }
                        // Phase 12A: Default capital fields
                        if (!Number.isInteger(f.negotiation.capital) || f.negotiation.capital < 0) {
                            f.negotiation.capital = 0;
                        }
                        if (!Number.isInteger(f.negotiation.spent_total) || f.negotiation.spent_total < 0) {
                            f.negotiation.spent_total = 0;
                        }
                        if (f.negotiation.last_capital_change_turn !== null && (!Number.isInteger(f.negotiation.last_capital_change_turn) || f.negotiation.last_capital_change_turn > currentTurn)) {
                            f.negotiation.last_capital_change_turn = null;
                        }
                    }
                }
            }
            // Phase 10: Ensure deterministic defaulting for FormationState ops fields.
            // Also canonicalize formation faction IDs and preserve army labels as force_label.
            const formations = candidate.formations;
            if (formations && typeof formations === 'object') {
                const formRec = formations;
                const keysSorted = Object.keys(formRec).sort();
                for (const key of keysSorted) {
                    const form = formRec[key];
                    if (!form || typeof form !== 'object')
                        continue;
                    // Canonicalize faction ID and preserve army label
                    if (typeof form.faction === 'string') {
                        const oldFaction = form.faction;
                        const canonicalFaction = canonicalizePoliticalSideId(oldFaction);
                        form.faction = canonicalFaction;
                        // If old faction was an army label (ARBiH/VRS/HVO), preserve it as force_label
                        if (oldFaction === "ARBiH" || oldFaction === "VRS" || oldFaction === "HVO") {
                            if (!form.force_label) {
                                form.force_label = oldFaction;
                            }
                        }
                        // If faction is now canonical and force_label is missing, set default
                        if (POLITICAL_SIDES.includes(canonicalFaction) && !form.force_label) {
                            // Default rule: always set when missing and faction is known
                            form.force_label = defaultArmyLabelForSide(canonicalFaction);
                        }
                    }
                    if (!form.ops || typeof form.ops !== 'object') {
                        form.ops = { fatigue: 0, last_supplied_turn: null };
                    }
                    else {
                        if (!Number.isInteger(form.ops.fatigue) || form.ops.fatigue < 0)
                            form.ops.fatigue = 0;
                        if (form.ops.last_supplied_turn !== null && (!Number.isInteger(form.ops.last_supplied_turn) || form.ops.last_supplied_turn > (candidate.meta?.turn ?? 0))) {
                            form.ops.last_supplied_turn = null;
                        }
                    }
                }
            }
            // Phase 10: Ensure deterministic defaulting for MilitiaPoolState fatigue field.
            // Also canonicalize militia pool faction IDs.
            const militiaPools = candidate.militia_pools;
            if (militiaPools && typeof militiaPools === 'object') {
                const poolRec = militiaPools;
                const keysSorted = Object.keys(poolRec).sort();
                for (const key of keysSorted) {
                    const pool = poolRec[key];
                    if (!pool || typeof pool !== 'object')
                        continue;
                    // Canonicalize faction ID (null is allowed)
                    if (pool.faction !== null && typeof pool.faction === 'string') {
                        pool.faction = canonicalizePoliticalSideId(pool.faction);
                    }
                    if (!Number.isInteger(pool.fatigue) || pool.fatigue < 0)
                        pool.fatigue = 0;
                }
            }
            // Phase 12A: Default negotiation_ledger and canonicalize faction_id in entries
            if (!('negotiation_ledger' in candidate) || candidate.negotiation_ledger === undefined) {
                candidate.negotiation_ledger = [];
            }
            else if (!Array.isArray(candidate.negotiation_ledger)) {
                candidate.negotiation_ledger = [];
            }
            else {
                // Canonicalize faction_id in ledger entries
                const ledger = candidate.negotiation_ledger;
                for (const entry of ledger) {
                    if (entry && typeof entry === 'object' && typeof entry.faction_id === 'string') {
                        entry.faction_id = canonicalizePoliticalSideId(entry.faction_id);
                    }
                }
            }
            // Phase 12C.3: Default supply_rights
            if (!('supply_rights' in candidate) || candidate.supply_rights === undefined) {
                candidate.supply_rights = { corridors: [] };
            }
            else {
                const supplyRights = candidate.supply_rights;
                if (!supplyRights || typeof supplyRights !== 'object') {
                    candidate.supply_rights = { corridors: [] };
                }
                else {
                    if (!Array.isArray(supplyRights.corridors)) {
                        supplyRights.corridors = [];
                    }
                    else {
                        // Canonicalize beneficiary in corridor rights
                        const corridors = supplyRights.corridors;
                        for (const corridor of corridors) {
                            if (corridor && typeof corridor === 'object' && typeof corridor.beneficiary === 'string') {
                                corridor.beneficiary = canonicalizePoliticalSideId(corridor.beneficiary);
                            }
                        }
                        // Ensure corridors are sorted by id (deterministic ordering)
                        supplyRights.corridors.sort((a, b) => {
                            const idA = a?.id ?? '';
                            const idB = b?.id ?? '';
                            return idA.localeCompare(idB);
                        });
                    }
                }
            }
            // Canonicalize faction IDs in front_posture and front_posture_regions keys
            if (candidate.front_posture && typeof candidate.front_posture === 'object') {
                const posture = candidate.front_posture;
                const oldKeys = Object.keys(posture).sort();
                const newPosture = {};
                for (const oldKey of oldKeys) {
                    const canonicalKey = canonicalizePoliticalSideId(oldKey);
                    newPosture[canonicalKey] = posture[oldKey];
                }
                candidate.front_posture = newPosture;
            }
            if (candidate.front_posture_regions && typeof candidate.front_posture_regions === 'object') {
                const postureRegions = candidate.front_posture_regions;
                const oldKeys = Object.keys(postureRegions).sort();
                const newPostureRegions = {};
                for (const oldKey of oldKeys) {
                    const canonicalKey = canonicalizePoliticalSideId(oldKey);
                    newPostureRegions[canonicalKey] = postureRegions[oldKey];
                }
                candidate.front_posture_regions = newPostureRegions;
            }
            return candidate;
        }
        default:
            throw new Error(`Unsupported schema_version ${String(version)}`);
    }
}
