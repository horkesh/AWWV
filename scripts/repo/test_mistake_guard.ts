/**
 * Test script for mistake guard helpers
 * 
 * Tests recordMistakeOnce and warnIfUnrecorded functionality
 */

import { recordMistakeOnce, warnIfUnrecorded, loadMistakes } from '../../tools/assistant/mistake_guard';

async function main(): Promise<void> {
  console.log('Testing mistake guard helpers...\n');
  
  // Test entry (will not be appended if already exists)
  const testEntry = {
    date: '2026-01-27',
    title: 'Test mistake entry for automation',
    description: 'This is a test entry to verify recordMistakeOnce and warnIfUnrecorded work correctly.',
    correct_behavior: 'This entry should only be appended once, even if warnIfUnrecorded is called multiple times.'
  };
  
  console.log('Test 1: warnIfUnrecorded with condition=true (first call)');
  warnIfUnrecorded(true, testEntry, 'test context');
  
  console.log('\nTest 2: warnIfUnrecorded with condition=true (second call - should not append again)');
  warnIfUnrecorded(true, testEntry, 'test context');
  
  console.log('\nTest 3: warnIfUnrecorded with condition=false (should do nothing)');
  warnIfUnrecorded(false, testEntry, 'test context');
  
  console.log('\nTest 4: recordMistakeOnce (should return false since already exists)');
  const result = recordMistakeOnce(testEntry);
  console.log(`Result: ${result} (false = already exists, true = was appended)`);
  
  console.log('\nTest 5: Load mistakes and verify test entry exists');
  const mistakes = loadMistakes();
  const found = mistakes.find(m => m.title === testEntry.title);
  if (found) {
    console.log(`✓ Found test entry: "${found.title}"`);
  } else {
    console.log('✗ Test entry not found in loaded mistakes');
  }
  
  console.log('\nTests complete.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
