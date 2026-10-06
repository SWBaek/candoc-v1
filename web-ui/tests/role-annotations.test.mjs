import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { harness } from './role-harness.mjs';
import { roleAnnotationDocument } from './fixtures/role-annotation-document.mjs';
import { runAnnotationSuggestions, validateAnnotationSuggestions, annotationMatches, validAnnotationRect } from '../server/role-annotations.mjs';
import { runCodexSuggestions } from '../server/codex-suggestions.mjs';

const launch = mode => ({ executable: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-role-annotation-app-server.mjs', import.meta.url)), mode] });
const options = mode => ({ roleAnnotationRunner: args => runAnnotationSuggestions({ ...args, launch: launch(mode), timeoutMs: 5000 }), roleModelRunner: args => runCodexSuggestions({ ...args, catalogue: true, launch: launch(mode) }) });
const rect = { left: .08, top: .04, width: .76, height: .09 }, comment = '같은 반복 영역과 분리된 두 줄을 머리말로 처리해줘';
const contextOf = async h => (await h.call('/api/role-annotations')).data;
async function annotate(h, overrides = {}) {
  const elements = (await h.call('/api/role-elements')).data;
  return h.put('/api/review/role-annotations', { sourceHash: elements.sourceHash, ruleHash: elements.ruleHash, page: 4, rect, comment, ...overrides });
}
async function recommend(h) {
  const c = await contextOf(h), state = await h.state();
  const result = await h.request('/api/review/role-annotation-suggestions', 'POST', { revision: state.revision, sourceHash: c.sourceHash, ruleHash: c.ruleHash, annotationId: c.annotations[0].id, model: 'test-model', effort: 'medium' });
  assert.equal(result.status, 202); return result.data;
}
async function finished(h) {
  for (let n = 0; n < 150; n++) { const c = await contextOf(h); if (c.jobs[0]?.status !== 'running') return c.jobs[0]; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error('synthetic annotation recommendation timed out');
}
async function apply(h, job, exceptions = [], extra = {}) {
  return h.put('/api/review/role-annotation-apply', { id: job.id, groupId: job.suggestions[0].id, sourceHash: job.sourceHash, ruleHash: job.ruleHash, exceptions, ...extra });
}

test('annotation rectangles select actual overlapping bbox/charspan, preserve split elements, and reject invalid/no-source/excluded areas', async t => {
  const h = await harness(t, roleAnnotationDocument()), before = await h.state();
  for (const bad of [{ ...rect, left: -1 }, { ...rect, height: 0 }, { ...rect, width: 2 }, { ...rect, extra: 1 }, { ...rect, top: null }]) assert.equal((await annotate(h, { rect: bad })).status, 400);
  assert.equal((await annotate(h, { rect: { left: .9, top: .3, width: .05, height: .1 } })).status, 400);
  assert.equal((await annotate(h, { comment: ' ' })).status, 400); assert.equal((await annotate(h, { sourceHash: 'old' })).status, 409);
  assert.deepEqual(await h.state(), before);
  assert.equal((await annotate(h)).status, 200);
  const c = await contextOf(h); assert.deepEqual(c.annotations[0].matches.map(row => row.ref), ['#/texts/9', '#/texts/10', '#/texts/11']);
  assert.ok(c.annotations[0].matches.every(row => row.locations[0].overlap > .99));
  assert.deepEqual((await h.state()).roleReviews, before.roleReviews); assert.deepEqual((await h.state()).stages, before.stages);
  await h.restart(); assert.deepEqual(await contextOf(h), c);
  await h.put('/api/review/pages/4', { status: 'excluded', reason: '제외', note: '', evidence: 'json' });
  assert.equal((await annotate(h)).status, 400);
  assert.equal(validAnnotationRect(rect), true);
  const items = (await h.call('/api/role-elements')).data.items;
  assert.ok(annotationMatches(items, 4, { left: .08, top: .04, width: .76, height: .025 }).some(row => row.locations[0].overlap < 1));
  assert.deepEqual(items.find(row => row.ref === '#/texts/9').provenance.map(({ page, rect, ...prov }) => prov), roleAnnotationDocument().texts[9].prov);
});

test('local app-server receives bbox/text only, model/effort and all prov; recommendations do not write judgments', async t => {
  const h = await harness(t, roleAnnotationDocument(), options('success'));
  assert.deepEqual((await h.call('/api/role-models')).data.models[0].efforts, ['low', 'medium']);
  await annotate(h); const before = await h.state(); await recommend(h); const job = await finished(h);
  assert.equal(job.status, 'completed', job.error);
  assert.deepEqual(job.suggestions[0].changes.map(row => row.ref), ['#/texts/0', '#/texts/1', '#/texts/2', '#/texts/9', '#/texts/10', '#/texts/11']);
  assert.ok(!job.suggestions[0].changes.some(row => row.ref === '#/texts/12'), 'real section title at nearby position is not a matching fixture proposal');
  assert.deepEqual(await h.state(), before);
  await h.restart(); assert.deepEqual((await contextOf(h)).jobs[0], job);
});

test('explicit apply excludes requested exceptions, preserves unrelated judgments/mixed prov/membership and persists/undoes', async t => {
  const h = await harness(t, roleAnnotationDocument(), options('success'));
  await h.put('/api/review/pages/1', { status: 'excluded', reason: '범위 제외', note: '', evidence: 'json' });
  const old = { ref: '#/texts/7', status: 'normal', region: 'footnote', role: 'footnote', parentRef: '', reason: '사용자 기존 판단', evidence: 'json', followUp: '' };
  await h.put('/api/review/roles', old);
  await h.put('/api/review/roles', { ...old, ref: '#/texts/2', region: 'body', role: 'body', reason: '이번 묶음에서 제외할 기존 판단' });
  await h.put('/api/review/roles', { ...old, ref: '#/texts/9', region: 'header', role: 'header', parentRef: '#/furniture' });
  await annotate(h); const before = await h.state(); await recommend(h); const job = await finished(h);
  assert.ok(!job.suggestions[0].changes.some(row => row.ref === '#/texts/0'));
  assert.equal((await apply(h, job, ['#/texts/2'])).status, 200);
  const saved = await h.state(); assert.deepEqual(saved.roleUndo.refs, ['#/texts/1', '#/texts/9', '#/texts/10', '#/texts/11']);
  assert.equal(saved.roleReviews.find(row => row.ref === '#/texts/9').parentRef, '#/furniture');
  assert.deepEqual(saved.roleReviews.find(row => row.ref === '#/texts/7'), before.roleReviews.find(row => row.ref === '#/texts/7'));
  assert.deepEqual(saved.roleReviews.find(row => row.ref === '#/texts/2'), before.roleReviews.find(row => row.ref === '#/texts/2'));
  assert.ok(!saved.roleReviews.some(row => ['#/texts/0', '#/texts/12'].includes(row.ref)));
  assert.ok(saved.roleReviews.filter(row => row.role === 'header').every(row => row.evidence === 'json'));
  await h.restart(); assert.deepEqual(await h.state(), saved); assert.equal((await contextOf(h)).jobs[0].stale, true);
  assert.equal((await h.put('/api/review/role-groups', { action: 'restore', id: saved.roleUndo.id })).status, 200);
  assert.deepEqual((await h.state()).roleReviews, before.roleReviews);
  assert.equal((await h.put('/api/review/stages/3', { action: 'complete', note: '주석 하나 확인' })).status, 400);
});

test('apply fails atomically and rejects invalid exceptions, stale source/revision/scope and restored conflicts', async t => {
  const h = await harness(t, roleAnnotationDocument(), options('success')); await annotate(h); await recommend(h); const job = await finished(h);
  const before = await h.state(), c = await contextOf(h);
  for (const exceptions of [['#/texts/999'], ['#/texts/1', '#/texts/1'], job.suggestions[0].changes.map(row => row.ref)]) assert.equal((await apply(h, job, exceptions)).status, 400);
  assert.equal((await apply(h, job, [], { sourceHash: 'old' })).status, 409);
  const db = new DatabaseSync(h.dbPath); db.exec("CREATE TRIGGER reject_annotation_write BEFORE INSERT ON role_reviews WHEN NEW.element_ref='#/texts/1' BEGIN SELECT RAISE(ABORT,'annotation atomic failure'); END;");
  assert.equal((await apply(h, job)).status, 500); assert.deepEqual(await h.state(), before); assert.deepEqual(await contextOf(h), c);
  db.exec('DROP TRIGGER reject_annotation_write'); db.close();
  await h.put('/api/review/pages/2', { status: 'excluded', reason: '이후 범위 변경', note: '', evidence: 'json' });
  const changed = await h.state(); assert.equal((await apply(h, job)).status, 409); assert.deepEqual(await h.state(), changed);
});

test('invalid agent refs fail closed; cancel preserves annotation without coverage and allows another request', async t => {
  const invalid = await harness(t, roleAnnotationDocument(), options('invalid')); await annotate(invalid); await recommend(invalid);
  assert.equal((await finished(invalid)).status, 'failed'); assert.equal((await invalid.state()).roleReviews.length, 0);
  const h = await harness(t, roleAnnotationDocument(), options('hang')); await annotate(h); const before = await h.state(), job = await recommend(h);
  assert.equal((await h.request('/api/review/role-annotation-suggestions', 'DELETE', { id: 'wrong' })).status, 409);
  assert.equal((await h.request('/api/review/role-annotation-suggestions', 'DELETE', { id: job.id })).status, 200);
  assert.equal((await contextOf(h)).jobs[0].status, 'cancelled'); assert.deepEqual(await h.state(), before);
  await recommend(h); await h.restart(); assert.equal((await contextOf(h)).jobs[0].status, 'cancelled');
});

test('validation rejects duplicate/cross-group refs, missing geometry and impossible role/region; partial intersections are explicit', async t => {
  const h = await harness(t, roleAnnotationDocument()); const items = (await h.call('/api/role-elements')).data.items;
  const context = { items, records: [], retainedPages: [2, 3, 4] };
  const row = { reason: '위치와 문구 대조', region: 'header', role: 'header', refs: ['#/texts/1'] };
  for (const result of [ { suggestions: [{ ...row, refs: ['#/texts/0'] }] }, { suggestions: [{ ...row, refs: ['#/texts/8'] }] }, { suggestions: [{ ...row, refs: ['#/texts/1', '#/texts/1'] }] }, { suggestions: [row, row] }, { suggestions: [{ ...row, role: 'footer' }] }, { suggestions: [{ ...row, role: 'body' }] }, { suggestions: [{ ...row, refs: ['#/groups/0'] }] } ]) assert.throws(() => validateAnnotationSuggestions(result, context));
  assert.deepEqual(validateAnnotationSuggestions({ suggestions: [] }, context), []);
});

test('interrupted durable job recovers as failed without changing coverage; in-flight scope changes make output stale', async t => {
  let release;
  const h = await harness(t, roleAnnotationDocument(), { roleAnnotationRunner: ({ context }) => new Promise(resolve => { release = () => resolve(validateAnnotationSuggestions({ suggestions: [{ reason: '합성 반복 후보', role: 'header', region: 'header', refs: ['#/texts/1', '#/texts/10', '#/texts/11'] }] }, context)); }) });
  await annotate(h); await recommend(h); while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  await h.put('/api/review/pages/2', { status: 'excluded', reason: '생성 중 범위 변경', note: '', evidence: 'json' }); release();
  const job = await finished(h), before = await h.state(); assert.equal(job.status, 'completed'); assert.equal(job.stale, true); assert.equal((await apply(h, job)).status, 409); assert.deepEqual(await h.state(), before);
  const db = new DatabaseSync(h.dbPath), value = { ...job, status: 'running', stale: undefined }; db.prepare('UPDATE role_annotation_jobs SET value_json=? WHERE id=?').run(JSON.stringify(value), job.id); db.close();
  await h.restart(); const recovered = (await contextOf(h)).jobs[0]; assert.equal(recovered.status, 'failed'); assert.match(recovered.error, /서버 재시작/); assert.deepEqual(await h.state(), before);
});
