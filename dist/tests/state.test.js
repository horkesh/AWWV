import assert from 'node:assert';
import { test } from 'node:test';
import { serializeState, deserializeState } from '../src/state/serialize.js';
const baseState = {
    meta: { turn: 0, seed: 'initial-seed' },
    factions: [
        {
            id: 'blue',
            profile: {
                authority: 10,
                legitimacy: 10,
                control: 10,
                logistics: 10,
                exhaustion: 0
            },
            areasOfResponsibility: []
        }
    ]
};
test('state serialization round trips cleanly', () => {
    const original = structuredClone(baseState);
    const payload = serializeState(original);
    const hydrated = deserializeState(payload);
    assert.deepStrictEqual(hydrated, original);
});
