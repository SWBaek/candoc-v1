import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { harness } from './role-harness.mjs';
import { roleQuestionDocument } from './fixtures/role-question-document.mjs';

const answer = (context, question, refs, action = 'apply', reason = '') => ({ questionId: question.id, fingerprint: question.fingerprint, sourceHash: context.sourceHash, ruleHash: context.ruleHash, refs, action, reason });
const contextOf = async h => (await h.call('/api/role-questions')).data;

test('questions use repeated position or numbered caption plus nearby object; ordinary short text creates no question and all prov remain', async t => {
  const h = await harness(t, roleQuestionDocument()), before = await h.state(), context = await contextOf(h);
  assert.equal(context.questions.length, 4);
  assert.deepEqual(context.questions.filter(q => q.kind === 'classification').map(q => q.refs), [['#/texts/10'], ['#/texts/11']]);
  assert.ok(context.questions[0].title.includes('반복 머리말'));
  const number = context.questions.find(q => q.proposed[0].role === 'page_number'); assert.ok(number.proposed.every(row => row.region === 'footer'));
  const { data } = await h.call('/api/role-elements');
  assert.deepEqual(data.items.find(row => row.ref === '#/texts/9').provenance.map(({ rect, page, ...prov }) => prov), roleQuestionDocument().texts[9].prov);
  assert.deepEqual(await h.state(), before, 'question detection has no review side effects');
});

test('question apply changes only selected in-scope refs, deduplicates confirmed roles, and restore/restart reopen affected answers', async t => {
  const h = await harness(t), c = await contextOf(h), q = c.questions[0];
  await h.put('/api/review/pages/1', { status: 'excluded', reason: '범위 제외', note: '', evidence: 'json' });
  let before = await h.state();
  assert.equal((await h.put('/api/review/role-questions', answer(c, q, q.refs))).status, 400); assert.deepEqual(await h.state(), before);
  assert.equal((await h.put('/api/review/role-questions', { ...answer(c, q, ['#/texts/1']), fingerprint: 'stale' })).status, 409);
  const result = await h.put('/api/review/role-questions', answer(c, q, ['#/texts/1', '#/texts/9'])); assert.equal(result.status, 200);
  assert.deepEqual(result.data.roleReviews.map(row => row.ref), ['#/texts/1', '#/texts/9']);
  assert.ok(result.data.roleReviews.every(row => row.evidence === 'json' && row.parentRef === ''));
  assert.equal((await contextOf(h)).questions[0].open, 1);
  const afterContext = await contextOf(h); await h.restart(); assert.deepEqual(await h.state(), result.data); assert.deepEqual(await contextOf(h), afterContext);
  assert.equal((await h.put('/api/review/role-groups', { action: 'restore', id: result.data.roleUndo.id })).status, 200);
  assert.deepEqual((await h.state()).roleReviews, before.roleReviews); assert.equal((await contextOf(h)).questions[0].open, 3);
  assert.ok((await contextOf(h)).questions[0].targets.find(row => row.ref === '#/texts/1').stale);
});

test('keep records proposal rejection without normal coverage; defer needs reason and blocks completion even for already reviewed roles', async t => {
  const h = await harness(t), c = await contextOf(h), q = c.questions[0], before = await h.state();
  assert.equal((await h.put('/api/review/role-questions', answer(c, q, ['#/texts/0'], 'defer'))).status, 400);
  assert.equal((await h.put('/api/review/role-questions', answer(c, q, ['#/texts/0'], 'keep', '실제 제목이므로 반복 제안을 거절'))).status, 200);
  assert.deepEqual((await h.state()).roleReviews, before.roleReviews); assert.equal((await h.state()).roleCoverage.reviewed, 0);
  let context = await contextOf(h); assert.equal(context.questions[0].targets[0].state, 'keep');
  assert.equal((await h.put('/api/review/role-questions', answer(c, q, ['#/texts/1'], 'defer', '실제 제목인지 원본 PDF에서 확인'))).status, 200);
  context = await contextOf(h); await h.restart(); assert.deepEqual(await contextOf(h), context);
  await h.put('/api/review/stages/2', { action: 'complete', includeUnreviewed: true, note: '' });
  const items = (await h.call('/api/role-elements')).data.items;
  for (const item of items) await h.put('/api/review/roles', { ref: item.ref, status: 'unjudgeable', region: 'unknown', role: 'unknown', parentRef: '', reason: '범위의 한계를 확인함', followUp: '원본 PDF 대조 필요', evidence: 'json' });
  await h.put('/api/review/roles', { ref: '#/texts/1', status: 'normal', region: 'header', role: 'header', parentRef: '', reason: '반복 영역 확인', followUp: '', evidence: 'json' });
  assert.equal((await contextOf(h)).questions[0].targets.find(row => row.ref === '#/texts/1').state, 'resolved', 'directly resolved role is not asked twice');
  await h.put('/api/review/role-questions', answer(c, q, ['#/texts/1'], 'defer', '추가 확인할 후속 의심'));
  assert.equal((await h.state()).roleCoverage.unreviewed, 0);
  assert.equal((await h.put('/api/review/stages/3', { action: 'complete', note: '전체 유지 범위 확인' })).status, 400);
});

test('page overview confirms only explicitly eligible refs, preserves prior records and rejects pending questions, mixed provenance and unknown roles', async t => {
  const h = await harness(t), context = await contextOf(h), page = context.pageScopes.find(page => page.page === 2);
  assert.ok(page.eligibleRefs.includes('#/texts/7')); assert.ok(!page.eligibleRefs.includes('#/texts/1') && !page.eligibleRefs.includes('#/texts/9'));
  const payload = { page: 2, refs: ['#/texts/7', '#/tables/0'], checkedAll: true, evidence: 'json' };
  let before = await h.state();
  for (const invalid of [{ checkedAll: false }, { refs: ['#/texts/9'] }, { refs: ['#/texts/1'] }, { refs: ['#/groups/1'] }, { refs: ['#/texts/8'] }]) { assert.equal((await h.put('/api/review/role-page-check', { ...payload, ...invalid })).status, 400); assert.deepEqual(await h.state(), before); }
  let result = await h.put('/api/review/role-page-check', payload); assert.equal(result.status, 200); assert.deepEqual(result.data.roleReviews.map(row => row.ref), ['#/tables/0', '#/texts/7']);
  const saved = result.data.roleReviews; before = await h.state();
  assert.equal((await h.put('/api/review/role-page-check', payload)).status, 400); assert.deepEqual(await h.state(), before);
  result = await h.put('/api/review/role-page-check', { ...payload, refs: ['#/texts/7', '#/groups/0'] }); assert.equal(result.status, 200);
  assert.deepEqual(result.data.roleReviews.filter(row => row.ref !== '#/groups/0'), saved);
  await h.put('/api/review/pages/2', { status: 'included', reason: '', note: '', evidence: 'json' });
  const stale = await h.state(); assert.ok(stale.roleReviews.find(row => row.ref === '#/texts/7').needsReview);
  assert.equal((await h.put('/api/review/role-page-check', payload)).status, 200, 'explicit page check may reconfirm known roles');
  assert.equal((await h.state()).roleReviews.find(row => row.ref === '#/texts/7').needsReview, false);
});

test('question and page mid-write failures roll back review rows, answers, undo and revision; stale revision never overwrites', async t => {
  const h = await harness(t), c = await contextOf(h), q = c.questions[0], db = new DatabaseSync(h.dbPath);
  db.exec("CREATE TRIGGER reject_question_write BEFORE INSERT ON role_reviews WHEN NEW.element_ref = '#/texts/1' BEGIN SELECT RAISE(ABORT, 'question atomic failure'); END;");
  let before = await h.state(), beforeQuestions = await contextOf(h);
  assert.equal((await h.put('/api/review/role-questions', answer(c, q, ['#/texts/0', '#/texts/1']))).status, 500);
  assert.deepEqual(await h.state(), before); assert.deepEqual(await contextOf(h), beforeQuestions); assert.equal(db.prepare('SELECT count(*) AS n FROM role_question_answers').get().n, 0);
  db.exec("DROP TRIGGER reject_question_write; CREATE TRIGGER reject_page_write BEFORE INSERT ON role_reviews WHEN NEW.element_ref = '#/texts/7' BEGIN SELECT RAISE(ABORT, 'page atomic failure'); END;");
  assert.equal((await h.put('/api/review/role-page-check', { page: 2, refs: ['#/tables/0', '#/texts/7'], checkedAll: true, evidence: 'json' })).status, 500); assert.deepEqual(await h.state(), before);
  db.exec('DROP TRIGGER reject_page_write'); db.close();
  await h.put('/api/review/role-questions', answer(c, q, ['#/texts/0'], 'keep', '제안 거절'));
  const current = await h.state(); assert.equal((await h.call('/api/review/role-questions', { revision: before.revision, ...answer(c, q, ['#/texts/1']) })).status, 409); assert.deepEqual(await h.state(), current);
});

test('applying a role keeps prior proposed membership and a conflicting provenance question stays open', async t => {
  const document = roleQuestionDocument();
  for (const index of [3, 4]) document.texts[index].prov.push({ page_no: index === 3 ? 1 : 2, bbox: { l: 48, r: 52, t: 96, b: 92, coord_origin: 'BOTTOMLEFT' }, charspan: [0, 1] });
  const h = await harness(t, document), c = await contextOf(h), numbers = c.questions.filter(q => q.proposed[0].role === 'page_number'), footer = numbers.find(q => q.proposed[0].region === 'footer'), header = numbers.find(q => q.proposed[0].region === 'header');
  await h.put('/api/review/roles', { ref: '#/texts/3', status: 'suspected', region: 'footer', role: 'page_number', parentRef: '#/furniture', reason: '기존 소속안', evidence: 'json', followUp: '상단 번호 출처도 확인' });
  assert.equal((await h.put('/api/review/role-questions', answer(c, footer, ['#/texts/3', '#/texts/4']))).status, 200);
  assert.equal((await h.state()).roleReviews.find(row => row.ref === '#/texts/3').parentRef, '#/furniture');
  assert.equal((await h.state()).roleReviews.find(row => row.ref === '#/texts/4').status, 'normal', 'footer label is compatible with page-number role, not an automatic source error');
  assert.equal((await contextOf(h)).questions.find(q => q.id === header.id).open, 2);
});

test('all question responses alone do not complete; explicit page coverage plus recorded unknown limits allows manual completion', async t => {
  const h = await harness(t, roleQuestionDocument()), c = await contextOf(h);
  await h.put('/api/review/stages/2', { action: 'complete', includeUnreviewed: true, note: '' });
  for (const q of c.questions) assert.equal((await h.put('/api/review/role-questions', answer(c, q, q.refs))).status, 200);
  const complete = () => h.put('/api/review/stages/3', { action: 'complete', note: '전체 유지 페이지의 큰 역할과 소속을 확인하고 출처 없는 항목의 한계를 기록함' });
  assert.equal((await complete()).status, 400);
  let context = await contextOf(h);
  for (const page of context.pageScopes) {
    const rows = new Set((await h.state()).roleReviews.map(row => row.ref)), refs = page.eligibleRefs.filter(ref => !rows.has(ref));
    if (refs.length) assert.equal((await h.put('/api/review/role-page-check', { page: page.page, refs, checkedAll: true, evidence: 'both' })).status, 200);
  }
  for (const ref of ['#/texts/8', '#/groups/1']) await h.put('/api/review/roles', { ref, status: 'unjudgeable', region: 'unknown', role: 'unknown', parentRef: '', reason: '출처가 없어 역할을 확정하지 못함', followUp: '원본 PDF와 대조', evidence: 'json' });
  assert.equal((await complete()).status, 200); assert.equal((await h.state()).roleCoverage.unreviewed, 0);
});
