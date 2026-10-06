import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createReviewApp } from '../server/app.mjs';
import { normalizedBox } from '../server/role-review.mjs';
import { roleDocument, pixelPng } from './fixtures/role-document.mjs';

const judgment = { status: 'normal', region: 'header', role: 'header', parentRef: '#/furniture', reason: '반복 문구와 상단 위치를 대조함', evidence: 'json', followUp: '' };
async function harness(t) {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'candoc-roles-')), dbPath = path.join(projectDir, 'inspection/review.sqlite');
  await mkdir(path.join(projectDir, 'raw/artifacts'), { recursive: true });
  const jsonPath = path.join(projectDir, 'raw/ieee1547-document.json'), bytes = JSON.stringify(roleDocument());
  await writeFile(jsonPath, bytes); await writeFile(path.join(projectDir, 'raw/artifacts/page.png'), pixelPng);
  let app, url;
  async function start() { app = createReviewApp({ projectDir, dbPath }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${app.server.address().port}`; }
  await start();
  const call = async (endpoint, body) => { const response = await fetch(url + endpoint, body ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined); return { status: response.status, data: await response.json() }; };
  t.after(async () => { await app.close(); assert.equal(await readFile(jsonPath, 'utf8'), bytes); assert.equal(path.dirname(projectDir), path.resolve(tmpdir())); assert.ok(path.basename(projectDir).startsWith('candoc-roles-')); await rm(projectDir, { recursive: true, force: true }); });
  const state = async () => (await call('/api/review')).data;
  const put = async (endpoint, body) => call(endpoint, { revision: (await state()).revision, ...body });
  return { call, state, put, dbPath, get app() { return app; }, restart: async () => { await app.close(); await start(); } };
}

test('repeat candidates normalize text and position, varying numbers group without automatic judgments; all provenance remains intact', async t => {
  const h = await harness(t), baseline = await h.state();
  const { data } = await h.call('/api/role-elements');
  const header = data.groups.find(group => group.kind === 'header'), numbers = data.groups.find(group => group.kind === 'page_number');
  assert.deepEqual(header.refs, ['#/texts/0', '#/texts/1', '#/texts/2', '#/texts/9']);
  assert.deepEqual(header.pages, [1, 2, 3, 4]); assert.deepEqual(numbers.refs, ['#/texts/3', '#/texts/4', '#/texts/5']);
  assert.ok(data.groups.every(group => !group.refs.includes('#/texts/6') && !group.refs.includes('#/texts/7')));
  const multi = data.items.find(item => item.ref === '#/texts/9');
  assert.deepEqual(multi.provenance.map(({ rect, page, ...prov }) => prov), roleDocument().texts[9].prov);
  assert.deepEqual(data.items.find(item => item.ref === '#/groups/0').pages, [2]);
  assert.equal(data.items.filter(item => !item.pages.length).length, 2);
  assert.deepEqual(await h.state(), baseline);
  for (const bbox of [{ l: 10, r: 80, t: 96, b: 92, coord_origin: 'BOTTOMLEFT' }, { l: 10, r: 80, t: 4, b: 8, coord_origin: 'TOPLEFT' }]) {
    const rect = normalizedBox(bbox, { width: 100, height: 100 });
    assert.ok(rect);
    for (const [key, expected] of Object.entries({ left: .1, top: .04, width: .7, height: .04 })) assert.ok(Math.abs(rect[key] - expected) <= 1e-12, `${bbox.coord_origin} ${key}: ${rect[key]}`);
  }
  assert.equal(normalizedBox({ l: -10, r: 80, t: 4, b: 8, coord_origin: 'TOPLEFT' }, { width: 100, height: 100 }), null);
});

test('batch judgments preserve exceptions and excluded pages; invalid target and mid-write failure roll back every target', async t => {
  const h = await harness(t), { data } = await h.call('/api/role-elements'), group = data.groups.find(group => group.kind === 'header');
  await h.put('/api/review/pages/1', { status: 'excluded', reason: '표지 유지 범위에서 제외', note: '', evidence: 'json' });
  let before = await h.state();
  assert.equal((await h.put('/api/review/role-groups', { action: 'save', groupId: group.id, refs: group.refs, ...judgment })).status, 400);
  assert.deepEqual(await h.state(), before);
  const refs = ['#/texts/1', '#/texts/9'];
  let result = await h.put('/api/review/role-groups', { action: 'save', groupId: group.id, refs, ...judgment }); assert.equal(result.status, 200);
  assert.deepEqual(result.data.roleReviews.map(row => row.ref), refs); assert.equal(result.data.roleReviews.find(row => row.ref === '#/texts/9').role, 'header');
  assert.ok(!result.data.roleReviews.some(row => row.ref === '#/texts/2'));
  const database = new DatabaseSync(h.dbPath);
  database.exec("CREATE TRIGGER reject_second_role BEFORE UPDATE ON role_reviews WHEN NEW.element_ref = '#/texts/9' BEGIN SELECT RAISE(ABORT, 'test atomic role failure'); END;");
  before = await h.state();
  assert.equal((await h.put('/api/review/role-groups', { action: 'save', groupId: group.id, refs, ...judgment, role: 'footer' })).status, 500);
  assert.deepEqual(await h.state(), before);
  database.exec('DROP TRIGGER reject_second_role'); database.close();
  result = await h.put('/api/review/role-groups', { action: 'save', groupId: group.id, refs: ['#/texts/1', '#/texts/6'], ...judgment }); assert.equal(result.status, 400);
  assert.deepEqual(await h.state(), before);
});

test('batch restore survives restart and restores per-target prior judgments; intervening edits and stale revisions reject without partial restoration', async t => {
  const h = await harness(t), { data } = await h.call('/api/role-elements'), group = data.groups.find(group => group.kind === 'header'), refs = group.refs.slice(0, 2);
  await h.put('/api/review/roles', { ref: refs[0], ...judgment, status: 'error', reason: '독립적으로 확인한 예외' });
  const before = await h.state();
  let result = await h.put('/api/review/role-groups', { action: 'save', groupId: group.id, refs, ...judgment });
  await h.restart(); assert.deepEqual(await h.state(), result.data);
  result = await h.put('/api/review/role-groups', { action: 'restore', id: result.data.roleUndo.id }); assert.equal(result.status, 200); assert.deepEqual(result.data.roleReviews, before.roleReviews);
  result = await h.put('/api/review/role-groups', { action: 'save', groupId: group.id, refs, ...judgment }); const id = result.data.roleUndo.id;
  await h.put('/api/review/roles', { ref: refs[0], ...judgment, reason: '나중에 변경한 개별 판단' });
  const modified = await h.state();
  assert.equal((await h.put('/api/review/role-groups', { action: 'restore', id })).status, 409); assert.deepEqual(await h.state(), modified);
  assert.equal((await h.call('/api/review/roles', { revision: before.revision, ref: refs[0], ...judgment })).status, 409);
  assert.deepEqual(await h.state(), modified);
});

test('completion requires full retained coverage and settled pages; unjudgeable records preserve limits, scope changes require reinspection', async t => {
  const h = await harness(t), { data } = await h.call('/api/role-elements');
  const complete = () => h.put('/api/review/stages/3', { action: 'complete', note: '전체 유지 범위의 영역과 소속을 검토하고 판단 불가 항목의 후속 확인을 기록함' });
  assert.equal((await complete()).status, 400);
  await h.put('/api/review/stages/2', { action: 'complete', includeUnreviewed: true, note: '' });
  assert.equal((await complete()).status, 400);
  for (const item of data.items) assert.equal((await h.put('/api/review/roles', { ref: item.ref, ...judgment, status: 'unjudgeable', region: 'unknown', role: 'unknown', parentRef: '', reason: '추가 원문 근거가 필요한 합성 테스트 항목', followUp: '원본 PDF에서 역할·소속 대조' })).status, 200);
  await h.put('/api/review/roles', { ref: '#/texts/0', ...judgment, status: 'suspected', followUp: '실제 제목인지 확인 필요' });
  assert.equal((await complete()).status, 400);
  await h.put('/api/review/roles', { ref: '#/texts/0', ...judgment });
  assert.equal((await complete()).status, 200);
  await h.put('/api/review/pages/2', { status: 'excluded', reason: '검수 범위 변경', note: '', evidence: 'json' });
  let state = await h.state(); assert.equal(state.stages.find(stage => stage.id === 3).status, 'needs_review');
  assert.equal(state.roleReviews.find(row => row.ref === '#/texts/9').needsReview, true, 'multi-page target remains in scope and needs review');
  assert.equal((await complete()).status, 400);
  await h.put('/api/review/pages/2', { status: 'included', reason: '검수 범위 복구', note: '', evidence: 'json' });
  state = await h.state(); assert.ok(state.roleCoverage.needsReview > 0);
  await h.restart(); assert.deepEqual(await h.state(), state);
});

test('self/cyclic parent, absent evidence and incomplete judgments never save, and role changes invalidate completed dependent stages', async t => {
  const h = await harness(t);
  for (const payload of [{ parentRef: '#/texts/0' }, { parentRef: '#/missing' }, { region: 'unknown' }, { status: 'suspected' }, { reason: '' }]) {
    const before = await h.state(); assert.equal((await h.put('/api/review/roles', { ref: '#/texts/0', ...judgment, ...payload })).status, 400); assert.deepEqual(await h.state(), before);
  }
  await h.put('/api/review/roles', { ref: '#/groups/0', ...judgment, parentRef: '#/groups/1' });
  assert.equal((await h.put('/api/review/roles', { ref: '#/groups/1', ...judgment, parentRef: '#/groups/0' })).status, 400);
  assert.equal((await h.put('/api/review/roles', { ref: '#/texts/8', ...judgment, evidence: 'both' })).status, 400);
  await h.put('/api/review/stages/4', { action: 'complete', note: '기존 독립 수동 검수 결과' });
  await h.put('/api/review/roles', { ref: '#/texts/0', ...judgment });
  assert.equal((await h.state()).stages.find(stage => stage.id === 4).status, 'needs_review');
});
