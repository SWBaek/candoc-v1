import { createHash, randomUUID } from 'node:crypto';

export const regions = ['header', 'footer', 'body', 'footnote', 'table', 'picture', 'unknown'];
export const roles = ['header', 'footer', 'page_number', 'body', 'title', 'footnote', 'caption', 'list', 'table', 'picture', 'formula', 'other', 'unknown'];

export function normalizedBox(bbox, page) {
  if (!bbox || !page || ![bbox.l, bbox.r, bbox.t, bbox.b, page.width, page.height].every(Number.isFinite) || page.width <= 0 || page.height <= 0 || !['TOPLEFT', 'BOTTOMLEFT'].includes(bbox.coord_origin)) return null;
  const left = Math.min(bbox.l, bbox.r) / page.width, right = Math.max(bbox.l, bbox.r) / page.width;
  const top = (bbox.coord_origin === 'TOPLEFT' ? Math.min(bbox.t, bbox.b) : page.height - Math.max(bbox.t, bbox.b)) / page.height;
  const bottom = (bbox.coord_origin === 'TOPLEFT' ? Math.max(bbox.t, bbox.b) : page.height - Math.min(bbox.t, bbox.b)) / page.height;
  return left >= 0 && top >= 0 && right <= 1 && bottom <= 1 && right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

export function buildRoleSource(document, pageMap) {
  const nodes = new Map();
  for (const name of ['body', 'furniture']) nodes.set(`#/${name}`, document[name] ?? {});
  for (const collection of ['texts', 'tables', 'pictures', 'groups']) (document[collection] ?? []).forEach((node, index) => nodes.set(`#/${collection}/${index}`, node ?? {}));
  function pagesOf(ref, path = new Set()) {
    if (path.has(ref)) return [];
    const node = nodes.get(ref); if (!node) return [];
    const next = new Set([...path, ref]);
    const own = (Array.isArray(node.prov) ? node.prov : []).map(prov => prov.page_no).filter(page => pageMap.has(page));
    return [...new Set([...own, ...(ref.startsWith('#/groups/') ? (node.children ?? []).flatMap(child => pagesOf(child.$ref, next)) : [])])].sort((a, b) => a - b);
  }
  const items = [...nodes].filter(([ref]) => !['#/body', '#/furniture'].includes(ref)).map(([ref, node]) => {
    const prov = Array.isArray(node.prov) ? node.prov : [];
    const cells = (node.data?.table_cells ?? []).map(cell => ({ text: cell.text ?? '', row: cell.start_row_offset_idx, column: cell.start_col_offset_idx }));
    const pages = pagesOf(ref);
    return { ref, sourceRef: node.self_ref ?? '', label: node.label ?? '', layer: node.content_layer ?? '', parentRef: node.parent?.$ref ?? '', children: (node.children ?? []).map(child => child.$ref), text: node.text ?? '', orig: node.orig ?? '', cells, pages,
      derivedPages: ref.startsWith('#/groups/'), provenance: prov.map(entry => ({ ...entry, page: entry.page_no, bbox: entry.bbox ?? null, rect: normalizedBox(entry.bbox, pageMap.get(entry.page_no)) })), repeatedPages: [] };
  });
  const byText = new Map();
  for (const item of items.filter(item => item.ref.startsWith('#/texts/') && item.text.trim())) {
    const key = item.text.replace(/\s+/g, ' ').trim();
    const matches = byText.get(key) ?? []; matches.push(item); byText.set(key, matches);
  }
  for (const matches of byText.values()) for (const item of matches) {
    item.repeatedPages = [...new Set(matches.flatMap(other => other.provenance.filter(b => b.rect && item.provenance.some(a => a.rect && a.page !== b.page && Math.abs(a.rect.top - b.rect.top) <= .04 && Math.abs(a.rect.left - b.rect.left) <= .05)).map(prov => prov.page)))].sort((a, b) => a - b);
  }
  const clusters = [];
  for (const item of items.filter(item => item.ref.startsWith('#/texts/'))) {
    const text = item.text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text) continue;
    const number = /^(?:page\s*)?(?:\d{1,4}|[ivxlcdm]{1,8})(?:\s*(?:\/|of)\s*\d{1,4})?$/i.test(text);
    for (const prov of item.provenance.filter(prov => prov.rect && (prov.rect.top < .16 || prov.rect.top + prov.rect.height > .82))) {
      const band = prov.rect.top < .16 ? 'header' : 'footer';
      const key = number ? '[page-number]' : text;
      const center = prov.rect.left + prov.rect.width / 2;
      let cluster = clusters.find(group => group.key === key && group.band === band && Math.abs(group.top - prov.rect.top) <= .04 && Math.abs(group.center - center) <= .08);
      if (!cluster) { cluster = { key, band, top: prov.rect.top, center, kind: number ? 'page_number' : band, members: [] }; clusters.push(cluster); }
      cluster.members.push({ ref: item.ref, page: prov.page });
    }
  }
  const groups = clusters.filter(group => new Set(group.members.map(member => member.page)).size >= 2).map(group => {
    const refs = [...new Set(group.members.map(member => member.ref))];
    return { id: createHash('sha256').update(JSON.stringify([group.key, group.band, refs])).digest('hex').slice(0, 16), kind: group.kind, band: group.band, normalizedText: group.key, refs, pages: [...new Set(items.filter(item => refs.includes(item.ref)).flatMap(item => item.pages))].sort((a, b) => a - b), representative: refs[0] };
  });
  return { items, groups, itemMap: new Map(items.map(item => [item.ref, item])), targets: [...nodes].map(([ref, node]) => ({ ref, label: node.label ?? ref, parentRef: node.parent?.$ref ?? '', pages: pagesOf(ref) })) };
}

export function createRoleStore({ db, reviewId, source, now, fail, onChange = () => {} }) {
  db.exec(`CREATE TABLE IF NOT EXISTS role_reviews (
    review_id INTEGER NOT NULL REFERENCES reviews(id), element_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('normal','error','suspected','unjudgeable')),
    region TEXT NOT NULL, role TEXT NOT NULL, parent_ref TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL, evidence TEXT NOT NULL, follow_up TEXT NOT NULL DEFAULT '',
    needs_review INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    PRIMARY KEY(review_id, element_ref));
    CREATE TABLE IF NOT EXISTS role_batches (
      id TEXT PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews(id), refs TEXT NOT NULL,
      before_json TEXT NOT NULL, after_json TEXT NOT NULL, restored INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);`);
  const data = source.roleSource;
  const records = () => db.prepare('SELECT element_ref AS ref, status, region, role, parent_ref AS parentRef, reason, evidence, follow_up AS followUp, needs_review AS needsReview, updated_at AS updatedAt FROM role_reviews WHERE review_id = ? ORDER BY element_ref').all(reviewId).map(row => ({ ...row, needsReview: !!row.needsReview }));
  const inScope = (item, excluded) => !item.pages.length || item.pages.some(page => !excluded.has(page));
  function scope() {
    const decisions = db.prepare('SELECT page_no, status FROM page_decisions WHERE review_id = ?').all(reviewId);
    const excluded = new Set(decisions.filter(row => row.status === 'excluded').map(row => row.page_no));
    return { items: data.items.filter(item => inScope(item, excluded)), unsettledPages: decisions.filter(row => ['unreviewed', 'pending'].includes(row.status)).map(row => row.page_no) };
  }
  function coverage() {
    const active = scope(), saved = new Map(records().map(row => [row.ref, row]));
    const result = { total: active.items.length, reviewed: 0, unreviewed: 0, needsReview: 0, suspected: 0, unlocated: active.items.filter(item => !item.pages.length).length, unsettledPages: active.unsettledPages };
    for (const item of active.items) {
      const row = saved.get(item.ref);
      if (!row) result.unreviewed++;
      else if (row.needsReview) result.needsReview++;
      else { result.reviewed++; if (row.status === 'suspected') result.suspected++; }
    }
    return result;
  }
  function markStages(ids, pages) {
    for (const id of ids) {
      const stage = db.prepare('SELECT status FROM stage_reviews WHERE review_id = ? AND stage_id = ?').get(reviewId, id);
      if (!stage || stage.status === 'pending') continue;
      db.prepare("UPDATE stage_reviews SET status = 'needs_review' WHERE review_id = ? AND stage_id = ?").run(reviewId, id);
      db.prepare('INSERT INTO review_impacts(review_id, stage_id, page_no, affected_pages, created_at) VALUES (?, ?, ?, ?, ?)').run(reviewId, id, pages[0] ?? 0, JSON.stringify(pages), now());
    }
  }
  function invalidatePage(page) {
    const affected = data.items.filter(item => item.pages.includes(page));
    for (const item of affected) db.prepare('UPDATE role_reviews SET needs_review = 1 WHERE review_id = ? AND element_ref = ?').run(reviewId, item.ref);
  }
  function validate(body) {
    const item = data.itemMap.get(body.ref);
    if (!item) fail(400, '유효한 원본 요소 참조가 필요합니다.');
    if (!scope().items.some(target => target.ref === item.ref)) fail(400, '제외한 페이지의 요소는 현재 검수 범위가 아닙니다.');
    if (!['normal', 'error', 'suspected', 'unjudgeable'].includes(body.status) || !regions.includes(body.region) || !roles.includes(body.role)) fail(400, '판단·영역·큰 역할을 선택하세요.');
    for (const key of ['reason', 'followUp', 'parentRef']) if (typeof body[key] !== 'string' || body[key].length > 10000) fail(400, `${key}는 10,000자 이하 문자열이어야 합니다.`);
    if (!body.reason.trim()) fail(400, '판단 근거와 사유가 필요합니다.');
    if (body.status === 'normal' && (body.region === 'unknown' || body.role === 'unknown')) fail(400, '정상 판단에는 확인한 영역과 큰 역할이 필요합니다.');
    if (['suspected', 'unjudgeable'].includes(body.status) && !body.followUp.trim()) fail(400, '의심·판단 불가에는 필요한 후속 확인을 기록하세요.');
    const keptPages = item.pages.filter(page => db.prepare('SELECT status FROM page_decisions WHERE review_id = ? AND page_no = ?').get(reviewId, page)?.status !== 'excluded');
    if (!['json', 'page_image', 'both'].includes(body.evidence) || (body.evidence !== 'json' && (!keptPages.length || keptPages.some(page => !source.assetFiles.has(page))))) fail(400, '사용 가능한 판단 근거를 선택하세요.');
    if (body.parentRef) {
      const targets = new Map(data.targets.map(target => [target.ref, target]));
      if (!targets.has(body.parentRef)) fail(400, '잠정 소속의 대상 참조가 없습니다.');
      const saved = new Map(records().map(row => [row.ref, row]));
      const seen = new Set([body.ref]); let current = body.parentRef;
      while (current) {
        if (seen.has(current)) fail(400, '잠정 소속에 자기 참조 또는 순환이 있습니다.');
        seen.add(current); current = saved.get(current)?.parentRef || targets.get(current)?.parentRef || '';
      }
    }
    return item;
  }
  function save(body) {
    const item = validate(body);
    const before = records().find(row => row.ref === body.ref);
    db.prepare(`INSERT INTO role_reviews(review_id, element_ref, status, region, role, parent_ref, reason, evidence, follow_up, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(review_id, element_ref) DO UPDATE SET
      status=excluded.status, region=excluded.region, role=excluded.role, parent_ref=excluded.parent_ref, reason=excluded.reason, evidence=excluded.evidence, follow_up=excluded.follow_up, needs_review=0, updated_at=excluded.updated_at`).run(reviewId, body.ref, body.status, body.region, body.role, body.parentRef, body.reason.trim(), body.evidence, body.followUp.trim(), now());
    const changed = !before || ['status', 'region', 'role', 'parentRef', 'reason', 'evidence', 'followUp'].some(key => before[key] !== (typeof body[key] === 'string' ? body[key].trim() : body[key]));
    if (changed || before?.needsReview) {
      // Changing an already completed review cannot silently retain its completion.
      markStages([3, 4, 5, 6, 7, 8, 9, 10, 11, 12], item.pages);
      onChange(item.pages);
    }
  }
  function assertComplete() {
    const result = coverage();
    if (result.unsettledPages.length) fail(400, `페이지 선별의 미검수·보류 ${result.unsettledPages.length}페이지를 먼저 확정하세요.`);
    if (result.unreviewed || result.needsReview || result.suspected) fail(400, `영역 검수의 미검수 ${result.unreviewed}개·재검토 ${result.needsReview}개·의심 ${result.suspected}개가 남아 있습니다.`);
  }
  const sameRecords = (refs, expected) => {
    const saved = new Map(records().map(row => [row.ref, row]));
    return JSON.stringify(refs.map(ref => saved.get(ref) ?? null)) === JSON.stringify(expected);
  };
  function undo() {
    const row = db.prepare('SELECT * FROM role_batches WHERE review_id = ? AND restored = 0 ORDER BY rowid DESC LIMIT 1').get(reviewId);
    return row ? { id: row.id, refs: JSON.parse(row.refs), canRestore: sameRecords(JSON.parse(row.refs), JSON.parse(row.after_json)), createdAt: row.created_at } : null;
  }
  function batch(body) {
    if (body.action === 'restore') {
      const row = db.prepare('SELECT * FROM role_batches WHERE review_id = ? AND id = ? AND restored = 0').get(reviewId, body.id);
      if (!row) fail(409, '복원할 일괄 저장이 없습니다.');
      const refs = JSON.parse(row.refs), before = JSON.parse(row.before_json);
      if (!sameRecords(refs, JSON.parse(row.after_json))) fail(409, '대상 판단이 이후에 변경되어 일괄 복원할 수 없습니다.');
      const active = new Set(scope().items.map(item => item.ref));
      if (refs.some(ref => !active.has(ref))) fail(409, '검수 범위가 바뀌어 일괄 복원할 수 없습니다.');
      refs.forEach((ref, index) => {
        db.prepare('DELETE FROM role_reviews WHERE review_id = ? AND element_ref = ?').run(reviewId, ref);
        const old = before[index];
        if (old) db.prepare('INSERT INTO role_reviews(review_id, element_ref, status, region, role, parent_ref, reason, evidence, follow_up, needs_review, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(reviewId, ref, old.status, old.region, old.role, old.parentRef, old.reason, old.evidence, old.followUp, Number(old.needsReview), old.updatedAt);
      });
      db.prepare('UPDATE role_batches SET restored = 1 WHERE id = ?').run(row.id);
      markStages([3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [...new Set(refs.flatMap(ref => data.itemMap.get(ref).pages))]);
      onChange([...new Set(refs.flatMap(ref => data.itemMap.get(ref).pages))]);
      return;
    }
    if (body.action !== 'save' || !Array.isArray(body.refs) || !body.refs.length || new Set(body.refs).size !== body.refs.length || body.refs.length > data.items.length) fail(400, '일괄 저장할 원본 요소를 중복 없이 선택하세요.');
    const group = data.groups.find(group => group.id === body.groupId);
    if (!group || body.refs.some(ref => !group.refs.includes(ref))) fail(400, '선택 대상이 해당 반복 후보 그룹에 속하지 않습니다.');
    saveBatch(body.refs.map(ref => ({ ...body, ref })));
  }
  function saveBatch(entries) {
    if (!entries.length || new Set(entries.map(row => row.ref)).size !== entries.length) fail(400, '저장할 대상을 중복 없이 선택하세요.');
    entries.forEach(validate);
    const refs = entries.map(row => row.ref);
    const saved = new Map(records().map(row => [row.ref, row])), before = refs.map(ref => saved.get(ref) ?? null);
    entries.forEach(save);
    const after = new Map(records().map(row => [row.ref, row]));
    db.prepare('INSERT INTO role_batches(id, review_id, refs, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), reviewId, JSON.stringify(refs), JSON.stringify(before), JSON.stringify(refs.map(ref => after.get(ref))), now());
  }
  return { records, coverage, save, saveBatch, validate, assertComplete, invalidatePage, batch, undo, markStages };
}
