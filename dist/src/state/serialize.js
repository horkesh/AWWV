export function serializeState(state) {
    const validation = validateState(state);
    if (!validation.ok) {
        throw new Error(formatIssues('State failed validation before serialize', validation.issues));
    }
    return JSON.stringify(state, null, 2);
}
export function deserializeState(payload) {
    const parsed = JSON.parse(payload);
    const normalized = structuredClonePolyfill(parsed);
    const validation = validateState(normalized);
    if (!validation.ok) {
        throw new Error(formatIssues('State failed validation after deserialize', validation.issues));
    }
    return normalized;
}
export function validateState(state) {
    const issues = [];
    if (!state || typeof state !== 'object') {
        issues.push({ path: 'state', message: 'State must be an object' });
        return { ok: issues.length === 0, issues };
    }
    validateMeta(state.meta, issues);
    validateFactions(state.factions, issues);
    return { ok: issues.length === 0, issues };
}
function validateMeta(meta, issues) {
    if (!meta || typeof meta !== 'object') {
        issues.push({ path: 'meta', message: 'Missing meta block' });
        return;
    }
    if (!Number.isInteger(meta.turn) || meta.turn < 0) {
        issues.push({ path: 'meta.turn', message: 'turn must be a non-negative integer' });
    }
    if (!meta.seed || typeof meta.seed !== 'string') {
        issues.push({ path: 'meta.seed', message: 'seed must be a non-empty string' });
    }
}
function validateAuthorityProfile(profile, path, issues) {
    if (!profile || typeof profile !== 'object') {
        issues.push({ path, message: 'authority profile missing' });
        return;
    }
    const keys = ['authority', 'legitimacy', 'control', 'logistics', 'exhaustion'];
    for (const key of keys) {
        const value = profile[key];
        if (!Number.isFinite(value)) {
            issues.push({ path: `${path}.${key}`, message: 'must be a finite number' });
        }
    }
}
function validateFactions(factions, issues) {
    if (!Array.isArray(factions)) {
        issues.push({ path: 'factions', message: 'factions must be an array' });
        return;
    }
    factions.forEach((faction, index) => {
        const basePath = `factions[${index}]`;
        if (!faction || typeof faction !== 'object') {
            issues.push({ path: basePath, message: 'faction must be an object' });
            return;
        }
        if (!faction.id || typeof faction.id !== 'string') {
            issues.push({ path: `${basePath}.id`, message: 'id must be a non-empty string' });
        }
        validateAuthorityProfile(faction.profile, `${basePath}.profile`, issues);
        if (!Array.isArray(faction.areasOfResponsibility)) {
            issues.push({ path: `${basePath}.areasOfResponsibility`, message: 'areasOfResponsibility must be an array' });
        }
        else if (!faction.areasOfResponsibility.every((id) => typeof id === 'string')) {
            issues.push({ path: `${basePath}.areasOfResponsibility`, message: 'areasOfResponsibility must contain strings' });
        }
    });
}
function formatIssues(prefix, issues) {
    const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    return `${prefix}: ${details}`;
}
function structuredClonePolyfill(input) {
    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(input);
    }
    return JSON.parse(JSON.stringify(input));
}
