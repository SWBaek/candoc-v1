import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReviewApp } from '../server/app.mjs';
import { fixtureJson } from './local-fixture.mjs';
import { extractPageInput, runCodexSuggestions, validateSuggestions } from '../server/codex-suggestions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launch = mode => ({ executable: process.execPath, args: [path.join(root, 'tests/fixtures/fake-app-server.mjs'), mode] });
const pages = [1, 2, 3].map(page => ({ page, items: [{ ref: '#/texts/0', label: 'text', text: 'page content' }] }));

test('page payload includes actual document-index cells and every original page without modifying JSON', async () => {
  const bytes = await readFile(fixtureJson);
  const doc = JSON.parse(bytes);
  const before = JSON.stringify(doc);
  const input = extractPageInput(doc);
  assert.equal(input.length, 138);
  for (const [page, ref] of [[13, '#/tables/4'], [14, '#/tables/5'], [15, '#/tables/6']]) {
    const item = input.find(item => item.page === page).items.find(item => item.ref === ref);
    assert.equal(item.label, 'document_index'); assert.ok(item.cells.some(text => text.length > 20));
  }
  assert.ok(input.find(item => item.page === 16).items.some(item => item.text === '1.2 Scope'));
  assert.equal(JSON.stringify(doc), before);
});

test('recommendation validation rejects unknown, overlapping, empty, and malformed results', () => {
  assert.deepEqual(validateSuggestions({ suggestions: [] }, [1, 2, 3]), []);
  const invalid = [
    { suggestions: [{ pages: [99], reason: 'unknown' }] },
    { suggestions: [{ pages: [1, 1], reason: 'duplicate' }] },
    { suggestions: [{ pages: [1], reason: 'first' }, { pages: [1], reason: 'overlap' }] },
    { suggestions: [{ pages: [], reason: 'empty' }] },
    { suggestions: [{ pages: [1], reason: ' ' }] },
    { suggestions: [{ pages: [1], reason: 'x'.repeat(501) }] },
    { suggestions: [{ pages: [1], reason: 'okay', apply: true }] },
    { suggestions: [], extra: true },
  ];
  for (const result of invalid) assert.throws(() => validateSuggestions(result, [1, 2, 3]));
});

test('stdio client uses a read-only ephemeral thread and only accepts final successful structured output', async () => {
  for (const mode of ['success', 'tool-request']) assert.deepEqual(await runCodexSuggestions({ pages, cwd: root, launch: launch(mode), timeoutMs: 5000 }), [{ pages: [1, 3], reason: '표지와 목차' }]);
  for (const [mode, message] of [['unauthenticated', /로그인/], ['bad-json', /JSON/], ['no-final', /최종/], ['failed-turn', /실패/], ['exit', /종료/]]) await assert.rejects(runCodexSuggestions({ pages, cwd: root, launch: launch(mode), timeoutMs: 5000 }), message);
});

test('process errors, cancellation, timeout, and oversize input do not become recommendations', async () => {
  await assert.rejects(runCodexSuggestions({ pages, cwd: root, launch: { executable: 'candoc-missing-executable', args: [] }, timeoutMs: 1000 }), /실행 파일/);
  const controller = new AbortController();
  const run = runCodexSuggestions({ pages, cwd: root, launch: launch('hang'), signal: controller.signal, timeoutMs: 5000 });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(run, /취소/);
  await assert.rejects(runCodexSuggestions({ pages, cwd: root, launch: launch('hang'), timeoutMs: 1000 }), /제한 시간/);
  await assert.rejects(runCodexSuggestions({ pages: [{ page: 1, items: [{ text: 'x'.repeat(1024 * 1024) }] }], cwd: root, launch: launch('success') }), /1 MiB/);
});

async function harness(t, runner) {
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-suggestion-api-'));
  await mkdir(path.join(directory, 'raw'));
  const jsonPath = path.join(directory, 'raw/ieee1547-document.json');
  await writeFile(jsonPath, JSON.stringify({ schema_name: 'DoclingDocument', version: '1.10.0', name: 'Recommendation fixture', pages: Object.fromEntries([1, 2, 3].map(page_no => [page_no, { page_no }])), texts: [{ self_ref: '#/texts/0', label: 'text', text: 'Cover', prov: [{ page_no: 1 }] }], tables: [{ self_ref: '#/tables/0', label: 'document_index', data: { table_cells: [{ text: 'Contents' }] }, prov: [{ page_no: 3 }] }] }));
  const baseline = await readFile(jsonPath, 'utf8');
  const app = createReviewApp({ projectDir: directory, dbPath: path.join(directory, 'review.sqlite'), suggestionRunner: runner });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); assert.ok(path.basename(directory).startsWith('candoc-suggestion-api-')); assert.equal(path.dirname(directory), path.resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  async function call(method = 'GET', body, endpoint = '/api/review/page-suggestions', origin) {
    const response = await fetch(url + endpoint, { method, ...(body ? { headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  return { app, call, jsonPath, baseline };
}

test('HTTP recommendation lifecycle never modifies review state; concurrency, origin and cancellation are guarded', async t => {
  let finish;
  const h = await harness(t, ({ pages: input, signal }) => {
    assert.ok(input.find(page => page.page === 3).items.some(item => item.cells.includes('Contents')));
    return new Promise((resolve, reject) => { finish = resolve; signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
  });
  const before = (await h.call('GET', undefined, '/api/review')).data;
  assert.equal((await h.call()).data.status, 'idle');
  assert.equal((await h.call('POST', {}, undefined, 'https://example.com')).status, 403);
  assert.equal((await h.call('POST', { pages: [1] })).status, 400);
  const started = await h.call('POST', {});
  assert.equal(started.status, 202); assert.equal(started.data.status, 'running');
  assert.equal((await h.call('POST', {})).status, 409);
  assert.equal((await h.call('DELETE', { id: 'other' })).status, 409);
  finish([{ pages: [1, 3], reason: '표지와 목차' }]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await h.call()).data.status, 'completed');
  assert.deepEqual((await h.call('GET', undefined, '/api/review')).data, before);
  const again = await h.call('POST', {});
  assert.equal((await h.call('DELETE', { id: again.data.id })).data.status, 'cancelled');
  assert.deepEqual((await h.call('GET', undefined, '/api/review')).data, before);
  assert.equal(await readFile(h.jsonPath, 'utf8'), h.baseline);
});

test('changed input and malformed runner output invalidate recommendations without saving decisions', async t => {
  let finish;
  const h = await harness(t, () => new Promise(resolve => { finish = resolve; }));
  const before = (await h.call('GET', undefined, '/api/review')).data;
  await h.call('POST', {}); finish([{ pages: [999], reason: 'bad page' }]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await h.call()).data.status, 'failed');
  assert.deepEqual((await h.call('GET', undefined, '/api/review')).data, before);
  await h.call('POST', {});
  await writeFile(h.jsonPath, h.baseline + ' ');
  finish([{ pages: [1], reason: 'cover' }]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await h.call()).status, 409);
  await writeFile(h.jsonPath, h.baseline);
  const result = await h.call();
  assert.equal(result.data.status, 'failed'); assert.match(result.data.error, /바뀌었습니다/);
  assert.deepEqual((await h.call('GET', undefined, '/api/review')).data, before);
});
