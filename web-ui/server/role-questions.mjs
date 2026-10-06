import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const names = { header: '반복 머리말', footer: '반복 꼬리말', page_number: '페이지 번호', caption: '캡션' };
export function originalRole(item) {
  const role = ({ page_header: 'header', page_footer: 'footer', text: 'body', paragraph: 'body', section_header: 'title', title: 'title', footnote: 'footnote', caption: 'caption', list_item: 'list', list: 'list', table: 'table', picture: 'picture', formula: 'formula' })[item.label] ?? 'unknown';
  const region = item.parentRef.startsWith('#/tables/') ? 'table' : item.parentRef.startsWith('#/pictures/') ? 'picture' : ({ header: 'header', footer: 'footer', footnote: 'footnote', table: 'table', picture: 'picture', unknown: 'unknown' })[role] ?? (item.layer === 'furniture' ? 'unknown' : 'body');
  return { region, role, parentRef: '' };
}

export function buildRoleQuestions(data) {
  const questions = data.groups.map(group => {
    const band = group.band;
    return { id: `repeat:${group.id}`, kind: 'repeat', groupId: group.id, refs: group.refs, pages: group.pages, title: `이 반복 요소를 ${names[group.kind]}로 확인할까요?`, reason: `${group.pages.length}개 원본 페이지의 ${band === 'header' ? '상단' : '하단'}에 ${group.kind === 'page_number' ? '번호 패턴' : '같거나 유사한 문구'}가 비슷한 위치로 반복됩니다. 실제 제목·본문인지 원문과 대조하세요.`, proposed: group.refs.map(ref => ({ ref, region: band, role: group.kind, parentRef: '' })) };
  });
  const repeated = new Set(questions.flatMap(question => question.refs));
  for (const item of data.items) {
    if (repeated.has(item.ref) || !['text', 'paragraph', 'section_header'].includes(item.label)) continue;
    const match = item.text.match(/^(Figure|Fig\.|Table|그림|표)\s+(\d+(?:[.-]\d+)*|[A-Z][.-]\d+)\s*[—–:.-]\s+\S/i);
    if (!match || item.text.length > 350) continue;
    const picture = /^(Figure|Fig\.|그림)$/i.test(match[1]);
    const nearby = data.items.filter(other => other.ref.startsWith(picture ? '#/pictures/' : '#/tables/') && item.provenance.some(a => a.rect && other.provenance.some(b => b.rect && a.page === b.page && Math.max(0, a.rect.top - b.rect.top - b.rect.height, b.rect.top - a.rect.top - a.rect.height) <= .18 && a.rect.left < b.rect.left + b.rect.width && b.rect.left < a.rect.left + a.rect.width)));
    if (!nearby.length) continue;
    questions.push({ id: `caption:${item.ref}`, kind: 'classification', refs: [item.ref], pages: item.pages, contextRefs: nearby.map(item => item.ref), title: `“${item.text.slice(0, 80)}”를 캡션으로 확인할까요?`, reason: `번호와 구분자가 있는 ${picture ? '그림' : '표'} 문구이며 같은 페이지 가까이에 ${picture ? '그림' : '표'}가 있습니다. 현재 라벨은 ${item.label}입니다. 정확한 연결 대상은 6단계에서 확인합니다.`, proposed: [{ ref: item.ref, region: 'body', role: 'caption', parentRef: '' }] });
  }
  return questions.map(question => ({ ...question, fingerprint: hash(question) }));
}

export function createRoleQuestionStore({ db, reviewId, source, roleStore, now, fail }) {
  db.exec(`CREATE TABLE IF NOT EXISTS role_question_answers (
    review_id INTEGER NOT NULL REFERENCES reviews(id), question_id TEXT NOT NULL, element_ref TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('apply','keep','defer')), reason TEXT NOT NULL, dependency_hash TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(review_id, question_id, element_ref));`);
  const data = source.roleSource, questions = buildRoleQuestions(data);
  const decisions = () => db.prepare('SELECT page_no, status FROM page_decisions WHERE review_id = ? ORDER BY page_no').all(reviewId);
  const active = (item, pages = decisions()) => !item.pages.length || item.pages.some(page => pages.find(row => row.page_no === page)?.status !== 'excluded');
  const dependency = (question, ref, rows = roleStore.records(), pages = decisions()) => hash([source.sourceHash, source.ruleHash, question.fingerprint, rows.find(row => row.ref === ref) ?? null, data.itemMap.get(ref).pages.map(page => pages.find(row => row.page_no === page))]);
  function context() {
    const rows = roleStore.records(), pages = decisions(), saved = new Map(rows.map(row => [row.ref, row]));
    const answers = db.prepare('SELECT question_id, element_ref, action, reason, dependency_hash FROM role_question_answers WHERE review_id = ?').all(reviewId);
    const items = questions.map(question => {
      const targets = question.refs.filter(ref => active(data.itemMap.get(ref), pages)).map(ref => {
        const row = saved.get(ref), proposal = question.proposed.find(item => item.ref === ref), answer = answers.find(item => item.question_id === question.id && item.element_ref === ref);
        // A current manual judgment answers the role question even when the user
        // chose a different role. Proposal rejection alone never creates this row.
        const appliedElsewhere = answers.some(answer => answer.element_ref === ref && answer.question_id !== question.id && answer.action === 'apply' && questions.some(other => other.id === answer.question_id && answer.dependency_hash === dependency(other, ref, rows, pages)));
        const matches = row && !row.needsReview && ['normal', 'error'].includes(row.status) && row.region !== 'unknown' && row.role !== 'unknown' && (!appliedElsewhere || row.role === proposal.role && row.region === proposal.region);
        const fresh = answer?.dependency_hash === dependency(question, ref, rows, pages);
        return { ref, state: fresh ? answer.action : matches ? 'resolved' : 'open', reason: fresh ? answer.reason : '', stale: !!answer && !fresh && !matches };
      });
      return { ...question, targets, open: targets.filter(row => ['open', 'defer'].includes(row.state)).length };
    });
    const blocked = new Set(items.flatMap(question => question.targets.filter(row => ['open', 'defer'].includes(row.state)).map(row => row.ref)));
    const pageScopes = source.pages.filter(page => pages.find(row => row.page_no === page.number)?.status !== 'excluded').map(page => ({ page: page.number, refs: data.items.filter(item => item.pages.includes(page.number) && active(item, pages)).map(item => item.ref) }));
    const pageEligible = ref => {
      const item = data.itemMap.get(ref), row = saved.get(ref), fields = row ?? originalRole(item);
      return !blocked.has(ref) && (!row || row.status === 'normal' || row.status === 'error') && fields.role !== 'unknown' && fields.region !== 'unknown' && data.targets.some(target => target.ref === item.parentRef) && item.pages.filter(page => pages.find(row => row.page_no === page)?.status !== 'excluded').length === 1;
    };
    return { sourceHash: source.sourceHash, ruleHash: source.ruleHash, questions: items, pageScopes: pageScopes.map(page => ({ ...page, eligibleRefs: page.refs.filter(pageEligible) })), unlocatedRefs: data.items.filter(item => !item.pages.length).map(item => item.ref) };
  }
  function answer(body) {
    const question = questions.find(question => question.id === body.questionId);
    if (!question || body.fingerprint !== question.fingerprint || body.sourceHash !== source.sourceHash || body.ruleHash !== source.ruleHash) fail(409, '문서 또는 질문 근거가 바뀌었습니다. 새로고침하세요.');
    if (!['apply', 'keep', 'defer'].includes(body.action) || !Array.isArray(body.refs) || !body.refs.length || new Set(body.refs).size !== body.refs.length || body.refs.some(ref => !question.refs.includes(ref) || !active(data.itemMap.get(ref)))) fail(400, '질문의 범위 내 대상을 중복 없이 선택하세요.');
    if (typeof body.reason !== 'string' || body.reason.length > 10000 || (body.action !== 'apply' && !body.reason.trim())) fail(400, '유지·보류에는 짧은 이유가 필요합니다.');
    if (body.action === 'apply') {
      const saved = new Map(roleStore.records().map(row => [row.ref, row]));
      const entries = body.refs.map(ref => {
        const proposal = question.proposed.find(row => row.ref === ref), item = data.itemMap.get(ref), original = originalRole(item);
        const equivalent = original.role === proposal.role || proposal.role === 'page_number' && original.region === proposal.region && ['header', 'footer'].includes(original.role);
        return { ...proposal, parentRef: saved.get(ref)?.parentRef ?? '', status: original.role !== 'unknown' && !equivalent ? 'error' : 'normal', evidence: 'json', reason: `${question.reason} 사용자가 선택한 대상에 이 역할을 확인함.${body.reason.trim() ? ` ${body.reason.trim()}` : ''}`, followUp: '' };
      });
      roleStore.saveBatch(entries);
    }
    for (const ref of body.refs) db.prepare(`INSERT INTO role_question_answers VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(review_id, question_id, element_ref) DO UPDATE SET action=excluded.action,reason=excluded.reason,dependency_hash=excluded.dependency_hash,updated_at=excluded.updated_at`).run(reviewId, question.id, ref, body.action, body.reason.trim(), dependency(question, ref), now());
    if (body.action === 'defer') roleStore.markStages([3, 12], [...new Set(body.refs.flatMap(ref => data.itemMap.get(ref).pages))]);
  }
  function confirmPage(body) {
    const scope = context().pageScopes.find(page => page.page === body.page);
    if (!scope || !Array.isArray(body.refs) || !body.refs.length || new Set(body.refs).size !== body.refs.length || body.refs.some(ref => !scope.eligibleRefs.includes(ref)) || body.checkedAll !== true) fail(400, '페이지 원문과 대상 역할을 확인하고 범위 내 확인 가능한 항목만 선택하세요.');
    if (!['json', 'both'].includes(body.evidence)) fail(400, '사용한 근거를 확인하세요.');
    const saved = new Map(roleStore.records().map(row => [row.ref, row]));
    const entries = body.refs.filter(ref => !saved.has(ref) || saved.get(ref).needsReview).map(ref => ({ ref, ...(saved.get(ref) ?? { ...originalRole(data.itemMap.get(ref)), status: 'normal', followUp: '' }), reason: `${saved.get(ref)?.reason ? saved.get(ref).reason + ' ' : ''}원본 ${body.page}페이지에서 선택한 요소의 영역·역할·원본 소속을 함께 확인함.`, evidence: body.evidence }));
    if (!entries.length) fail(400, '새로 확인할 미검수 대상이 없습니다. 기존 기록은 보존합니다.');
    roleStore.saveBatch(entries);
  }
  function assertComplete() {
    if (context().questions.some(question => question.targets.some(target => target.state === 'defer'))) fail(400, '보류한 영역 질문의 후속 확인이 남아 있습니다.');
  }
  return { context, answer, confirmPage, assertComplete };
}
