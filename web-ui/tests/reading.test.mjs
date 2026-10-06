import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createReviewApp } from '../server/app.mjs';
import { inspectReadingTree } from '../server/reading-review.mjs';
import { readingDocument, pixelPng, readingJudgment as judgment, seedReadingRoles, seedReading } from './fixtures/reading-document.mjs';

async function harness(t, options) {
  const directory = await mkdtemp(path.join(tmpdir(), 'candoc-reading-')), dbPath = path.join(directory, 'inspection/review.sqlite');
  await mkdir(path.join(directory, 'raw/artifacts'), { recursive: true });
  const jsonPath = path.join(directory, 'raw/ieee1547-document.json'), document = readingDocument(options);
  options?.alter?.(document);
  const bytes = JSON.stringify(document);
  await writeFile(jsonPath, bytes); await writeFile(path.join(directory, 'raw/artifacts/page.png'), pixelPng);
  let app, url;
  async function start() { app = createReviewApp({ projectDir: directory, dbPath }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${app.server.address().port}`; }
  await start();
  const call = async (endpoint, body) => { const response = await fetch(url + endpoint, body ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined); return { status: response.status, data: await response.json() }; };
  const state = async () => (await call('/api/review')).data;
  const put = async (endpoint, body) => call(endpoint, { revision: (await state()).revision, ...body });
  const context = async () => (await call('/api/reading-review')).data;
  const ready = async () => { await put('/api/review/stages/2', { action: 'complete', includeUnreviewed: true, note: '' }); await seedReadingRoles(put, (await context()).items); };
  t.after(async () => { await app.close(); assert.equal(await readFile(jsonPath, 'utf8'), bytes); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('candoc-reading-')); await rm(directory, { recursive: true, force: true }); });
  return { call, state, put, context, ready, dbPath, restart: async () => { await app.close(); await start(); } };
}
test('tree sequence spans column memberships, every provenance occurrence retained, no inferred judgments', async t => {
  const h = await harness(t), before = await h.state(), c = await h.context();
  assert.deepEqual(await h.state(), before);
  assert.equal(c.scopes.flatMap(s => s.entries).length, 9);
  assert.deepEqual(c.items.find(i => i.ref === '#/texts/3').provenance.map(({ rect, page, ...p }) => p), readingDocument().texts[3].prov);
  await h.ready(); const scope = (await h.context()).scopes.find(s => s.page === 1 && s.region === 'body');
  assert.deepEqual(scope.originalOrder, ['#/texts/1@0', '#/texts/0@0']); assert.equal(scope.parentRef, '여러 소속');
  assert.equal((await h.state()).orderReviews.length, 0);
});
test('exact scope permutation, status gates, stale revision and restart persistence', async t => {
  const h = await harness(t); await h.ready(); const scope = (await h.context()).scopes.find(s => s.page === 1 && s.region === 'body'), before = await h.state();
  for (const order of [[], [scope.originalOrder[0], scope.originalOrder[0]], [scope.originalOrder[0], '#/texts/2@0']]) {
    assert.equal((await h.put('/api/review/reading-order', { ...judgment, id: scope.id, order })).status, 400); assert.deepEqual(await h.state(), before);
  }
  const order = [...scope.originalOrder].reverse();
  assert.equal((await h.put('/api/review/reading-order', { ...judgment, id: scope.id, order })).status, 400);
  const saved = await h.put('/api/review/reading-order', { ...judgment, status: 'error', id: scope.id, order }); assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.orderReviews[0].order, order);
  assert.equal((await h.call('/api/review/reading-order', { revision: before.revision, ...judgment, id: scope.id, order: scope.originalOrder })).status, 409);
  await h.restart(); assert.deepEqual(await h.state(), saved.data);
  assert.equal((await h.put('/api/review/reading-order', { ...judgment, id: scope.id, order: scope.originalOrder })).status, 200);
});
test('multiple paragraph/table/footnote links, explicit none and invalid endpoints/type/region reject atomically', async t => {
  const h = await harness(t); await h.ready();
  const links = [ ['#/texts/0@0', '#/texts/2@0', 'paragraph'], ['#/tables/0@0', '#/tables/1@0', 'table'], ['#/texts/4@0', '#/texts/5@0', 'footnote'] ].map(([from, to, kind]) => ({ from, to, kind, relation: 'continuation' }));
  const body = { ...judgment, id: '1:2', links, noConnection: false }, saved = await h.put('/api/review/page-connections', body); assert.equal(saved.status, 200); assert.deepEqual(saved.data.boundaryReviews[0].links, links);
  for (const change of [{ links: [] }, { noConnection: true }, { links: [...links, links[0]] }, { links: [{ ...links[0], to: '#/texts/3@1' }] }, { links: [{ ...links[0], kind: 'table' }] }, { links: [{ ...links[0], kind: 'footnote' }] }, { links: [{ ...links[0], to: '#/texts/5@0' }] }, { links: [{ ...links[0], relation: 'unknown' }] }]) {
    assert.equal((await h.put('/api/review/page-connections', { ...body, ...change })).status, 400); assert.deepEqual(await h.state(), saved.data);
  }
  assert.equal((await h.put('/api/review/page-connections', { ...body, links: [], noConnection: true })).status, 200);
});
test('transaction failure rolls back record, revision, downstream statuses and impacts', async t => {
  const h = await harness(t); await h.ready(); const scope = (await h.context()).scopes[0];
  await h.put('/api/review/stages/6', { action: 'complete', note: '격리 DB 수동 검사' }); const before = await h.state();
  const db = new DatabaseSync(h.dbPath); db.exec("CREATE TRIGGER fail_reading_impact BEFORE INSERT ON review_impacts BEGIN SELECT RAISE(ABORT, 'test reading rollback'); END;");
  assert.equal((await h.put('/api/review/reading-order', { ...judgment, id: scope.id, order: scope.originalOrder })).status, 500); assert.deepEqual(await h.state(), before);
  db.exec('DROP TRIGGER fail_reading_impact'); db.close();
});
test('role edit, excluded gap and scope return require related reinspection', async t => {
  const h = await harness(t); await h.ready(); await seedReading(h.put, await h.context());
  assert.equal((await h.put('/api/review/stages/4', { action: 'complete', note: '전체 유지 범위 대조' })).status, 200);
  await h.put('/api/review/roles', { ...judgment, ref: '#/texts/0', region: 'body', role: 'body', parentRef: '#/groups/0', reason: '소속 변경 대조' });
  let state = await h.state(); assert.equal(state.stages.find(s => s.id === 4).status, 'needs_review'); assert.ok(state.orderReviews.find(r => r.order.includes('#/texts/0@0')).needsReview); assert.equal(state.orderReviews.find(r => r.order.includes('#/texts/3@1')).needsReview, false);
  await h.put('/api/review/pages/2', { status: 'excluded', reason: '합성 중간 페이지 제외', note: '', evidence: 'json' });
  const c = await h.context(); assert.deepEqual(c.boundaries.map(b => [b.id, b.skippedPages]), [['1:3', [2]]]); assert.ok((await h.state()).readingCoverage.unreviewed >= 1); assert.ok(!(await h.state()).boundaryReviews.some(r => r.id === '1:3'));
  assert.equal((await h.put('/api/review/page-connections', { ...judgment, id: '1:2', links: [], noConnection: true })).status, 400);
  await h.put('/api/review/pages/2', { status: 'included', reason: '제외 취소', note: '', evidence: 'json' }); state = await h.state(); assert.ok(state.boundaryReviews.every(r => r.needsReview)); assert.ok(state.roleCoverage.needsReview);
});
test('cycles, duplicate references, missing references and unreachable nodes diagnose and block normal source sequence', async t => {
  for (const [kind, alter] of [
    ['cycle', doc => doc.groups[0].children.push({ $ref: '#/groups/0' })],
    ['duplicate', doc => doc.body.children.push({ $ref: '#/texts/0' })],
    ['missing', doc => doc.groups[0].children.push({ $ref: '#/texts/999' })],
    ['unreachable', doc => { doc.body.children = doc.body.children.filter(child => child.$ref !== '#/texts/0'); }],
  ]) {
    const h = await harness(t, { alter }); await h.ready(); const c = await h.context();
    assert.ok(c.diagnostics.some(issue => issue.kind === kind), kind);
    const affected = c.scopes.filter(scope => scope.diagnostics.length);
    assert.ok(affected.length); assert.ok(affected.every(scope => !scope.sourceOrderKnown));
    assert.equal(c.scopes.flatMap(scope => scope.entries).length, 9, 'all original prov occurrences remain, duplicates do not manufacture occurrences');
    const before = await h.state();
    for (const scope of affected) assert.equal((await h.put('/api/review/reading-order', { ...judgment, id: scope.id, order: scope.originalOrder })).status, 400);
    assert.deepEqual(await h.state(), before);
    const scope = affected[0];
    assert.equal((await h.put('/api/review/reading-order', { ...judgment, status: 'unjudgeable', followUp: '원본 트리 확인', id: scope.id, order: scope.originalOrder })).status, 200);
  }
});
test('disconnected cycles diagnosed without fabricated source indexes; unaffected root sequence stays available', () => {
  const source = { readingRoots: { '#/body': ['#/texts/0'], '#/furniture': [] }, roleSource: { items: [{ ref: '#/texts/0', children: [] }, { ref: '#/groups/0', children: ['#/groups/1'] }, { ref: '#/groups/1', children: ['#/groups/0', '#/texts/1'] }, { ref: '#/texts/1', children: [] }] } };
  const result = inspectReadingTree(source);
  assert.ok(result.diagnostics.some(d => d.kind === 'cycle')); assert.ok(result.diagnostics.some(d => d.kind === 'unreachable' && d.ref === '#/texts/1'));
  assert.equal(result.treeOrder.get('#/texts/0'), 0); assert.equal(result.treeOrder.has('#/texts/1'), false);
});
test('role group restore never revives prior reading confirmation without reinspection', async t => {
  const h = await harness(t, { alter: doc => { doc.texts[0].text = doc.texts[2].text = 'Repeated Header'; } }); await h.ready(); await seedReading(h.put, await h.context());
  const group = (await h.call('/api/role-elements')).data.groups.find(g => g.kind === 'header'); assert.ok(group);
  const saved = await h.put('/api/review/role-groups', { ...judgment, action: 'save', groupId: group.id, refs: group.refs, region: 'header', role: 'header', parentRef: '#/furniture' }); assert.equal(saved.status, 200);
  await seedReading(h.put, await h.context());
  const restored = await h.put('/api/review/role-groups', { action: 'restore', id: saved.data.roleUndo.id }); assert.equal(restored.status, 200);
  assert.ok(restored.data.orderReviews.filter(r => r.order.some(id => ['#/texts/0@0', '#/texts/2@0'].includes(id))).every(r => r.needsReview));
  assert.equal(restored.data.orderReviews.find(r => r.order.includes('#/texts/3@1')).needsReview, false);
  assert.equal((await h.put('/api/review/stages/4', { action: 'complete', note: '복원 후 미재검토 완료 시도' })).status, 400);
});
test('unlocated/orphan and independent uncertainty visible; completion requires entire scope and follow-up', async t => {
  const h = await harness(t, { unlocated: true });
  const complete = () => h.put('/api/review/stages/4', { action: 'complete', note: '미확인 한계와 후속 확인 기록' });
  assert.equal((await complete()).status, 400);
  const c = await h.context(), missing = c.scopes.find(s => s.page === 0); assert.equal(missing.sourceOrderKnown, false);
  assert.equal((await h.put('/api/review/reading-order', { ...judgment, id: missing.id, order: missing.originalOrder })).status, 400);
  assert.equal((await h.put('/api/review/reading-order', { ...judgment, status: 'unjudgeable', followUp: 'PDF 출처 확인', id: missing.id, order: missing.originalOrder })).status, 200);
  await h.put('/api/review/stages/2', { action: 'complete', includeUnreviewed: true, note: '' });
  for (const item of c.items) assert.equal((await h.put('/api/review/roles', { ...judgment, ref: item.ref, status: 'unjudgeable', region: 'unknown', role: 'unknown', parentRef: '', followUp: '원문 역할 대조' })).status, 200);
  await seedReading(h.put, await h.context(), { ...judgment, status: 'unjudgeable', followUp: '원문 순서·연결 대조' });
  assert.equal((await complete()).status, 200);
  const scope = (await h.context()).scopes.find(s => s.page === 1);
  await h.put('/api/review/reading-order', { ...judgment, status: 'suspected', followUp: '읽기 순서 확인', id: scope.id, order: scope.originalOrder }); assert.equal((await complete()).status, 400);
});
