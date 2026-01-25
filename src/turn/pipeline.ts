import { GameState } from '../state/game_state.js';
import { defaultSteps } from './steps.js';

export type Rng = () => number;

export interface TurnContext {
  state: GameState;
  rng: Rng;
  seed: string;
}

export interface TurnStep {
  name: string;
  execute: (context: TurnContext) => void;
}

export interface TurnOptions {
  seed?: string;
  steps?: TurnStep[];
}

export function executeTurn(state: GameState, options: TurnOptions = {}): GameState {
  const seed = options.seed ?? state.meta.seed ?? 'default-seed';
  const workingState = cloneState(state);

  workingState.meta = {
    ...workingState.meta,
    seed,
    turn: workingState.meta.turn + 1
  };

  const rng = createRng(seed);
  const steps = options.steps ?? defaultSteps;
  const context: TurnContext = { state: workingState, rng, seed };

  for (const step of steps) {
    step.execute(context);
  }

  return context.state;
}

export function createRng(seed: string | number): Rng {
  const numericSeed = typeof seed === 'number' ? seed : hashSeed(seed);
  let a = numericSeed >>> 0;

  return function rng(): number {
    // Mulberry32 for fast, deterministic RNG
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

function cloneState(state: GameState): GameState {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(state);
  }

  return JSON.parse(JSON.stringify(state)) as GameState;
}
