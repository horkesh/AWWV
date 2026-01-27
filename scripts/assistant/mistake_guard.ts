/**
 * Re-export of the canonical mistake guard module for scripts/.
 *
 * This exists so scripts can import:
 *   import { loadMistakes, assertNoRepeat, appendMistake } from "../assistant/mistake_guard";
 *
 * ...while the authoritative implementation lives in tools/assistant/mistake_guard.ts
 */
export * from '../../tools/assistant/mistake_guard';
