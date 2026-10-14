import assert from 'node:assert/strict';
import { createPackedApp, SAMPLE_LABEL } from './packed-app.js';

const app = await createPackedApp();
try {
  const sponsors = await app.cli('ask', SAMPLE_LABEL, '--chip', 'sponsors');
  assert.match(sponsors, /doesn't say who sponsored it/);
  const answer = await app.cli(
    'ask',
    SAMPLE_LABEL,
    'When does this act take effect?',
  );
  assert.match(answer, /Section 2/);
  assert.match(answer, /\[S:sec-2\]/);
  assert.match(answer, /p\. 2, lines 4–5/);
  const list = await app.cli('list');
  assert(list.includes(SAMPLE_LABEL));
  assert.match(list, /pdf/);
  await app.serve();
  console.log('Packed CLI and /api/health passed.');
} finally {
  await app.dispose();
}
