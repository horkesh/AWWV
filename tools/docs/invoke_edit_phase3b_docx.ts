/**
 * Invoke Phase 3B docx edit script (python-docx) and then run validator.
 * Deterministic: no timestamps, no random IDs. Uses mistake guard.
 */

import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

loadMistakes();
assertNoRepeat('phase3a ab harness weaklink two-cluster seed variant nonzero bottleneck');

const editScript = resolve(ROOT, 'tools/docs/edit_phase3b_spec.py');
const validateScript = resolve(ROOT, 'tools/docs/validate_phase3b_docs.py');

execSync(`py -3 "${editScript}"`, { stdio: 'inherit', cwd: ROOT });
try {
  execSync(`py -3 "${validateScript}"`, { stdio: 'inherit', cwd: ROOT });
} catch (e: unknown) {
  const status = typeof e === 'object' && e !== null && 'status' in e ? (e as { status: number }).status : 1;
  process.exit(status);
}
