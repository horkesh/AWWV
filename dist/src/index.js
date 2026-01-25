import { executeTurn } from './turn/pipeline.js';
import { serializeState } from './state/serialize.js';
const initial = {
    meta: {
        turn: 0,
        seed: 'smoke-seed'
    },
    factions: []
};
const next = executeTurn(initial, { seed: initial.meta.seed });
process.stdout.write(serializeState(next) + '\n');
