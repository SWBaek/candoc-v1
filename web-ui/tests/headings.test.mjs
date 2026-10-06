import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createReviewApp } from '../server/app.mjs';
import { headingDocument, pixelPng, judgment, headingPayload, nonHeading } from './fixtures/heading-document.mjs';
import { seedReading } from './fixtures/reading-document.mjs';
import { runHeadingSuggestions, listHeadingModels, validateHeadingSuggestions } from '../server/heading-suggestions.mjs';
import { validateHeadingForest } from '../server/heading-tree.mjs';

async function harness(t, document = headingDocument(), options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-headings-')), dbPath = path.join(directory, 'inspection/review.sqlite'), jsonPath = path.join(directory, 'raw/ieee1547-document.json'), bytes = JSON.stringify(document);
  await mkdir(path.join(directory, 'raw/artifacts'), { recursive: true }); await writeFile(jsonPath, bytes); await writeFile(path.join(directory, 'raw/artifacts/page.png'), pixelPng);
  let app, url;
  async function start() { app = createReviewApp({ projectDir: directory, dbPath, ...options }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${app.server.address().port}`; }
  await start();
  const call = async (endpoint, body) => { const response = await fetch(url + endpoint, body ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined); return { status: response.status, data: await response.json() }; };
  const state = async () => (await call('/api/review')).data, context = async () => (await call('/api/heading-review')).data;
  const put = async (endpoint, body) => call(endpoint, { revision: (await state()).revision, ...body });
  const save = async (items = [], pages = [], extra = {}) => put('/api/review/headings', { action: 'save', items, pages, ...extra });
  const reading = async () => seedReading(put, (await call('/api/reading-review')).data);
  const ready = async () => { await put('/api/review/stages/2', { action: 'complete', includeUnreviewed: true, note: '' }); for (const item of (await context()).allTexts) { const role = item.ref === '#/texts/4' ? 'header' : item.ref === '#/texts/3' ? 'body' : 'title'; assert.equal((await put('/api/review/roles', { ref: item.ref, ...judgment, role, region: role === 'header' ? 'header' : 'body', parentRef: '#/body' })).status, 200); } await reading(); };
  t.after(async () => { await app.close(); assert.equal(await readFile(jsonPath, 'utf8'), bytes); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-headings-')); await rm(directory, { recursive: true, force: true }); });
  const request = async (endpoint, method, body) => { const response = await fetch(url + endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  return { request, call, state, context, put, save, ready, reading, dbPath, restart: async () => { await app.close(); await start(); } };
}
const pageCheck = (page, part = 'body') => ({ page, ...judgment, part, checkedAllText: true, issues: [] });
test('candidates are evidence, running headers distinguished, all provenance preserved and candidate-outside path retained', async t => {
  const h = await harness(t), before = await h.state(), c = await h.context(); assert.deepEqual(await h.state(), before); assert.equal(c.allTexts.length, 6); assert.equal(c.candidates.length, 4); assert.equal(c.allTexts.find(i => i.ref === '#/texts/3').candidate, false);
  assert.deepEqual(c.allTexts[5].provenance.map(({ rect, page, ...entry }) => entry), headingDocument().texts[5].prov); await h.ready(); assert.equal((await h.context()).allTexts.find(i => i.ref === '#/texts/4').running, true);
  assert.equal((await h.save([nonHeading((await h.context()).allTexts.find(i => i.ref === '#/texts/3'))])).status, 200); assert.ok((await h.context()).candidates.some(i => i.ref === '#/texts/3'));
});
test('A/B individual confirmation, reason-only edit, overview and completion end without cross-invalidating peers', async t => {
  const h = await harness(t); await h.ready(); const c = await h.context();
  for (const item of c.candidates) assert.equal((await h.save([item.ref === '#/texts/4' ? nonHeading(item) : headingPayload(item)])).status, 200);
  let state = await h.state(); assert.ok(state.headingReviews.every(row => !row.needsReview));
  const a = state.headingReviews.find(row => row.ref === '#/texts/0'); assert.equal((await h.save([{ ...a, reason: '사유만 보완' }])).status, 200); assert.ok((await h.state()).headingReviews.every(row => !row.needsReview));
  assert.equal((await h.save([], [pageCheck(1), pageCheck(2, 'appendix'), pageCheck(3, 'appendix')], { range: { from: 1, to: 3, exceptions: [] } })).status, 200);
  assert.equal((await h.put('/api/review/stages/5', { action: 'complete', note: '전체 후보/문서 구분 대조' })).status, 200);
  state = await h.state(); await h.save([{ ...a, reason: '완료 후 근거 설명만 보완' }]); assert.equal((await h.state()).stages.find(s => s.id === 5).status, 'completed'); await h.restart(); assert.ok((await h.state()).headingReviews.every(row => !row.needsReview));
});
test('parent/subtree change and same-order reading recheck settles without freshness hash loop', async t => {
  const h = await harness(t); await h.ready(); const c = await h.context(); await h.save(c.candidates.map(i => i.ref === '#/texts/4' ? nonHeading(i) : headingPayload(i)));
  let state = await h.state(), b = state.headingReviews.find(r => r.ref === '#/texts/1');
  assert.equal((await h.save([{ ...b, level: 2, parentRef: '#/texts/0' }])).status, 200); assert.ok((await h.state()).readingCoverage.needsReview); await h.reading();
  assert.ok((await h.state()).headingReviews.every(row => !row.needsReview));
  assert.equal((await h.save([], [pageCheck(1), pageCheck(2, 'appendix'), pageCheck(3, 'appendix')])).status, 200); assert.equal((await h.put('/api/review/stages/5', { action: 'complete', note: '부모/하위와 4단계 동일 순서 재대조' })).status, 200);
});
test('saved stage4 permutation drives heading evidence order and multi-prov refs appear once', async t => {
  const h = await harness(t); await h.ready(); const reading = (await h.call('/api/reading-review')).data, scope = reading.scopes.find(s => s.page === 1 && s.region === 'body');
  assert.equal((await h.put('/api/review/reading-order', { ...judgment, status: 'error', id: scope.id, order: [...scope.originalOrder].reverse() })).status, 200);
  const c = await h.context(); assert.equal(c.allTexts[0].ref, '#/texts/3'); assert.ok(c.allTexts[0].readingOccurrences.every(row => row.state === 'proposal')); assert.equal(c.allTexts.filter(i => i.ref === '#/texts/5').length, 1); assert.equal(c.allTexts.find(i => i.ref === '#/texts/5').readingOccurrences.length, 2);
  assert.ok(c.allTexts.find(i => i.ref === '#/texts/0').sourceIndex < c.allTexts.find(i => i.ref === '#/texts/1').sourceIndex); assert.ok(c.allTexts.find(i => i.ref === '#/texts/0').readingIndex > c.allTexts.find(i => i.ref === '#/texts/1').readingIndex);
});
test('impossible proposals rejected for normal and error, range exceptions and missing/uncertainty gates', async t => {
  const h = await harness(t); await h.ready(); const c = await h.context(), a = headingPayload(c.allTexts[0]), b = headingPayload(c.allTexts[1]);
  for (const status of ['normal', 'error']) for (const items of [[{ ...a, status, parentRef: a.ref }], [{ ...a, status, parentRef: '#/texts/999', level: 2 }], [{ ...a, status, level: 2 }], [{ ...a, status }, { ...b, status, position: a.position }], [{ ...a, status, parentRef: b.ref, level: 2 }, { ...b, status }], [{ ...a, status }, { ...b, status, level: 3, parentRef: a.ref }], [{ ...a, status }, nonHeading(c.allTexts[1], { status }), headingPayload(c.allTexts[2], { status, level: 2, parentRef: b.ref })], [{ ...a, status }, { ...b, status }, headingPayload(c.allTexts[2], { status, level: 2, parentRef: a.ref })]]) {
    const before = await h.state(); assert.equal((await h.save(items)).status, 400); assert.deepEqual(await h.state(), before);
  }
  assert.throws(() => validateHeadingForest([{ ref: 'A', isHeading: true, level: 1, parentRef: '', part: 'body', position: 0 }, { ref: 'B', isHeading: true, level: 1, parentRef: '', part: 'body', position: 1 }, { ref: 'C', isHeading: true, level: 2, parentRef: 'A', part: 'body', position: 2 }], (_, message) => { throw Error(message); }), /연속/);
  const items = c.candidates.map(i => nonHeading(i, { status: 'unjudgeable', followUp: '원문 제목 여부 추가 확인' })); await h.save(items);
  const pages = [1, 2].map(page => ({ ...pageCheck(page, 'unknown'), status: 'unjudgeable', followUp: '누락 제목과 구분 확인', issues: ['missing'] }));
  assert.equal((await h.save([], pages, { range: { from: 1, to: 3, exceptions: [3] } })).status, 200);
  assert.equal((await h.put('/api/review/stages/5', { action: 'complete', note: '전체 미확인 항목 기록' })).status, 400);
  assert.equal((await h.save([], [pages[0]], { range: { from: 1, to: 3, exceptions: [3] } })).status, 400);
  assert.equal((await h.save([], [{ ...pages[0], range: { from: 1, to: 3, exceptions: [3] } }])).status, 400, 'row-level range also requires all explicitly selected targets');
  await h.save([], [{ ...pages[0], page: 3 }]); await h.reading(); assert.equal((await h.put('/api/review/stages/5', { action: 'complete', note: '제목 여부/누락 판단 불가 한계와 후속 확인' })).status, 200);
});
test('only changed title descendants/overview stale; metadata preserves peers, role and reading changes require reinspection', async t => {
  const h = await harness(t); await h.ready(); const c = await h.context();
  await h.save(c.candidates.map(item => item.ref === '#/texts/4' ? nonHeading(item) : headingPayload(item, item.ref === '#/texts/2' ? { parentRef: '#/texts/1', level: 2 } : {})));
  await h.save([], [pageCheck(1), pageCheck(2, 'appendix'), pageCheck(3, 'appendix')]);
  let state = await h.state(), b = state.headingReviews.find(row => row.ref === '#/texts/1');
  await h.save([{ ...b, reason: '동일 의미의 근거 보충' }]); state = await h.state(); assert.ok(state.headingReviews.every(row => !row.needsReview)); assert.ok(state.outlinePages.every(row => !row.needsReview));
  await h.save([{ ...b, sectionNumber: '2.' }]); state = await h.state(); assert.equal(state.headingReviews.find(row => row.ref === '#/texts/0').needsReview, false); assert.equal(state.headingReviews.find(row => row.ref === '#/texts/1').needsReview, false); assert.equal(state.headingReviews.find(row => row.ref === '#/texts/2').needsReview, true); assert.deepEqual(state.outlinePages.filter(row => row.needsReview).map(row => row.page), [1]);
  await h.reading(); state = await h.state(); await h.save([state.headingReviews.find(row => row.ref === '#/texts/2')]); await h.save([], [pageCheck(1)]); assert.equal((await h.put('/api/review/stages/5', { action: 'complete', note: '후손 및 동일 값 개요 재확인' })).status, 200);
  await h.put('/api/review/roles', { ref: '#/texts/1', ...judgment, role: 'body', region: 'body', parentRef: '#/body' }); assert.ok((await h.state()).headingReviews.find(row => row.ref === '#/texts/1').needsReview); assert.equal((await h.put('/api/review/stages/5', { action: 'complete', note: '관련 변경 미확인' })).status, 400);
});
test('broken source order never appears as original even after an explicit stage4 error proposal', async t => {
  const document = headingDocument(); document.body.children.push({ $ref: '#/texts/0' }); const h = await harness(t, document);
  await h.put('/api/review/stages/2', { action: 'complete', includeUnreviewed: true, note: '' });
  for (const item of (await h.context()).allTexts) await h.put('/api/review/roles', { ref: item.ref, ...judgment, role: 'title', region: 'body', parentRef: '#/body' });
  const reading = (await h.call('/api/reading-review')).data;
  for (const scope of reading.scopes) assert.equal((await h.put('/api/review/reading-order', { ...judgment, status: 'error', id: scope.id, order: scope.originalOrder })).status, 200);
  const c = await h.context(), item = c.allTexts.find(row => row.ref === '#/texts/0'); assert.equal(item.sourceIndex, null); assert.ok(item.readingOccurrences.every(row => row.state === 'proposal')); assert.equal(c.allTexts.length, document.texts.length); assert.ok(c.diagnoses.some(row => row.kind === 'source_order' && row.refs.includes(item.ref)));
});
test('intervening target edit rejects saved batch restoration atomically', async t => {
  const h = await harness(t); await h.ready(); const c = await h.context(); const saved = await h.save(c.candidates.map(item => item.ref === '#/texts/4' ? nonHeading(item) : headingPayload(item)));
  const firstBatch = saved.data.headingUndo.id; await h.save([{ ...saved.data.headingReviews[0], reason: '이후 독립 검토에서 근거 변경' }]); const before = await h.state(); assert.equal((await h.put('/api/review/headings', { action: 'restore', id: firstBatch })).status, 409); assert.deepEqual(await h.state(), before);
});
test('atomic mid-write failure, stale revisions, saved restore/restart and excluded mixed provenance preserve source', async t => {
  const h = await harness(t); await h.ready(); const c = await h.context(), items = c.candidates.map(i => i.ref === '#/texts/4' ? nonHeading(i) : headingPayload(i));
  const db = new DatabaseSync(h.dbPath); db.exec("CREATE TRIGGER fail_second_heading BEFORE INSERT ON heading_reviews WHEN NEW.element_ref='#/texts/1' BEGIN SELECT RAISE(ABORT,'synthetic heading atomic failure'); END;"); const before = await h.state(); assert.equal((await h.save(items)).status, 500); assert.deepEqual(await h.state(), before); db.exec('DROP TRIGGER fail_second_heading'); db.close();
  const saved = await h.save(items); assert.equal(saved.status, 200); await h.restart(); assert.deepEqual(await h.state(), saved.data);
  assert.equal((await h.call('/api/review/headings', { action: 'save', revision: before.revision, items, pages: [] })).status, 409);
  assert.equal((await h.put('/api/review/headings', { action: 'restore', id: saved.data.headingUndo.id })).status, 200); assert.equal((await h.state()).headingReviews.length, 0);
  await h.reading(); await h.save(items); await h.put('/api/review/pages/2', { status: 'excluded', reason: '합성 중간 페이지 제외', note: '', evidence: 'json' });
  const mixed = (await h.context()).allTexts.find(item => item.ref === '#/texts/5'); assert.deepEqual(mixed.pages, [2, 3]); assert.equal(mixed.provenance.length, 2); assert.equal(mixed.readingOccurrences.length, 1); assert.ok((await h.state()).headingReviews.find(r => r.ref === mixed.ref).needsReview);
  await h.put('/api/review/pages/2', { status: 'included', reason: '범위 복원', note: '', evidence: 'json' }); assert.equal((await h.context()).allTexts.find(i => i.ref === mixed.ref).readingOccurrences.length, 2); assert.equal((await h.put('/api/review/stages/12', { action: 'complete', note: '미확인 결과 완료 시도' })).status, 400);
});


test('short addresses do not become candidates; classified outline and numbered missing candidates are distinct', async t => {
  const document = headingDocument(), address = structuredClone(document.texts[3]); address.self_ref = '#/texts/6'; address.text = address.orig = '123 Main Street'; document.texts.push(address); document.body.children.push({ $ref: address.self_ref });
  const h = await harness(t, document), c = await h.context();
  assert.equal(c.allTexts.filter(row => row.classifiedHeading).length, 3);
  assert.equal(c.allTexts.find(row => row.ref === '#/texts/2').missingCandidate, true);
  assert.equal(c.allTexts.find(row => row.ref === '#/texts/4').candidate, false); assert.equal(c.allTexts.find(row => row.ref === '#/texts/6').candidate, false);
  assert.equal((await h.state()).headingReviews.length, 0);
  // A single bare number is insufficient: matching numbering family required.
});

test('structural-only transaction preserves independent stale Annex and requires explicit review confirmation', async t => {
  const h = await harness(t); await h.ready(); const c = await h.context();
  await h.save(c.candidates.map(item => headingPayload(item, item.ref === '#/texts/2' ? { level: 2, parentRef: '#/texts/1' } : {})));
  let state = await h.state(), annex = state.headingReviews.find(row => row.ref === '#/texts/5');
  const metadata = await h.save([{ ...annex, reason: '독립 근거 보완' }]); await h.put('/api/review/headings', { action: 'restore', id: metadata.data.headingUndo.id });
  state = await h.state(); annex = state.headingReviews.find(row => row.ref === '#/texts/5'); assert.equal(annex.needsReview, true);
  const b = state.headingReviews.find(row => row.ref === '#/texts/1'), child = state.headingReviews.find(row => row.ref === '#/texts/2');
  const saved = await h.save([{ ...b, level: 2, parentRef: '#/texts/0' }, { ...child, level: 3 }], [], { confirmedRefs: [] }); assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.headingReviews.find(row => row.ref === annex.ref), annex);
  assert.equal(saved.data.headingReviews.find(row => row.ref === b.ref).needsReview, true);
  await h.restart(); assert.deepEqual((await h.state()).headingReviews, saved.data.headingReviews);
  assert.equal((await h.save([b], [], { confirmedRefs: ['unknown'] })).status, 400);
});

test('Codex model/effort catalogue and heading structured final output use existing isolated stdio protocol', async t => {
  const h = await harness(t); await h.ready(); const context = await h.context(), before = await h.state();
  const launch = { executable: process.execPath, args: [path.resolve('tests/fixtures/fake-app-server.mjs'), 'heading'] };
  const models = await listHeadingModels({ cwd: process.cwd(), launch }); assert.deepEqual(models[0].efforts, ['low', 'medium']);
  const suggestions = await runHeadingSuggestions({ context, cwd: process.cwd(), model: 'test-model', effort: 'medium', launch });
  assert.equal(suggestions[0].changes.length, 2); assert.equal(suggestions[0].changes[0].after.parentRef, '#/texts/0');
  await assert.rejects(runHeadingSuggestions({ context, cwd: process.cwd(), model: 'absent', effort: 'medium', launch }), /모델/);
  await assert.rejects(runHeadingSuggestions({ context, cwd: process.cwd(), model: 'test-model', effort: 'unsupported', launch }), /effort/);
  assert.throws(() => validateHeadingSuggestions({ suggestions: [{ reason: 'bad', changes: [{ ref: '#/texts/999', isHeading: true, level: 1, parentRef: '', sectionNumber: '' }] }] }, context), /참조/);
  assert.deepEqual(await h.state(), before);
});

test('recommendation preview checks version, refs and exception subtree atomically and never records approval as review', async t => {
  const h = await harness(t, headingDocument(), { headingSuggestionRunner: async ({ context }) => validateHeadingSuggestions({ suggestions: [{ reason: 'synthetic recommendation', changes: [{ ref: '#/texts/1', isHeading: true, level: 2, parentRef: '#/texts/0', sectionNumber: '2' }, { ref: '#/texts/2', isHeading: true, level: 3, parentRef: '#/texts/1', sectionNumber: '3' }] }] }, context) });
  const before = await h.state();
  // HTTP helper exposes POST separately; recommendation uses no review mutation.
  const started = await h.request('/api/review/heading-suggestions', 'POST', { revision: before.revision, model: 'test-model', effort: 'medium' }); assert.equal(started.status, 202);
  let job; for (let i = 0; i < 30; i++) { job = (await h.call('/api/review/heading-suggestions')).data; if (job.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(job.status, 'completed', job.error);
  const preview = body => h.request('/api/review/heading-suggestions/preview', 'POST', { id: job.id, groupId: '0', revision: before.revision, exceptions: [], ...body });
  assert.equal((await preview({})).status, 200); assert.deepEqual(await h.state(), before);
  assert.equal((await preview({ exceptions: ['#/texts/1'] })).status, 400); // invalid partial subtree is rejected
  assert.deepEqual(await h.state(), before);
  await h.put('/api/review/stages/5', { action: 'save_note', note: 'version change' }); assert.equal((await preview({})).status, 409);
});
