// Opt-in live generation check. Uses existing Codex authentication and an isolated review DB.
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createReviewApp } from '../server/app.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsonPath = path.join(root, '../working-project/ieee-1547/raw/ieee1547-document.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHash = hash(await readFile(jsonPath));
const directory = await mkdtemp(path.join(tmpdir(), 'candoc-live-codex-'));
const app = createReviewApp({ dbPath: path.join(directory, 'review.sqlite') });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const startedAt = Date.now();
try {
  const before = await (await fetch(url + '/api/review')).json();
  const started = await fetch(url + '/api/review/page-suggestions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(started.status, 202);
  let result;
  while (Date.now() - startedAt < 620000) {
    result = await (await fetch(url + '/api/review/page-suggestions')).json();
    if (result.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(result.status, 'completed', result.error ?? result.status);
  assert.deepEqual(await (await fetch(url + '/api/review')).json(), before, 'recommendation must not modify review state');
  assert.equal(hash(await readFile(jsonPath)), sourceHash, 'original JSON must remain unchanged');
  const report = { checkedAt: new Date().toISOString(), elapsedSeconds: (Date.now() - startedAt) / 1000, sourceHash, ruleHash: result.ruleHash, status: result.status, recommendations: result.suggestions, reviewUnchanged: true, sourceUnchanged: true, isolatedReviewDatabase: true };
  await mkdir(path.join(root, 'qa'), { recursive: true });
  await writeFile(path.join(root, 'qa/codex-suggestions.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
  assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-live-codex-'));
  await rm(directory, { recursive: true, force: true });
}
