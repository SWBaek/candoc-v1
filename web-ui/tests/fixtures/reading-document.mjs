export { pixelPng } from './role-document.mjs';
export function readingDocument({ unlocated = false } = {}) {
  const prov = (page, left = 10) => ({ page_no: page, bbox: { l: left, t: 90, r: left + 30, b: 70, coord_origin: 'BOTTOMLEFT' }, charspan: [0, 10] });
  const texts = [0, 1, 2, 3, 4, 5].map(i => ({ self_ref: `#/texts/${i}`, parent: { $ref: i === 1 ? '#/groups/0' : '#/body' }, children: [], label: i >= 4 ? 'footnote' : 'text', text: `Reading paragraph ${i}`, orig: `Original ${i}`, prov: [prov(i === 0 || i === 1 || i === 4 ? 1 : 2, i === 1 ? 60 : 10)] }));
  texts[3].prov.push(prov(3));
  if (unlocated) texts.push({ self_ref: '#/texts/6', parent: { $ref: '#/body' }, children: [], label: 'text', text: 'Unlocated orphan', prov: [] });
  const tables = [1, 2].map((page, i) => ({ self_ref: `#/tables/${i}`, parent: { $ref: '#/body' }, label: 'table', prov: [prov(page)], data: { table_cells: [{ text: `Cell ${i}`, start_row_offset_idx: 0, start_col_offset_idx: 0 }] } }));
  return { schema_name: 'DoclingDocument', version: '1.10.0', name: 'Synthetic multi-column reading fixture', texts, tables, pictures: [], groups: [{ self_ref: '#/groups/0', parent: { $ref: '#/body' }, label: 'unspecified', children: [{ $ref: '#/texts/1' }] }], body: { self_ref: '#/body', children: ['#/groups/0', '#/texts/0', '#/texts/2', '#/texts/3', '#/texts/4', '#/texts/5', '#/tables/0', '#/tables/1'].map($ref => ({ $ref })) }, furniture: { self_ref: '#/furniture', children: [] }, pages: Object.fromEntries([1, 2, 3].map(page => [page, { page_no: page, size: { width: 100, height: 100 }, image: { uri: 'artifacts/page.png' } }])) };
}
export const readingJudgment = { status: 'normal', reason: '원본 트리와 페이지 대조', followUp: '', evidence: 'json' };
export async function seedReadingRoles(put, items) {
  for (const item of items) {
    const footnote = item.label === 'footnote', table = item.ref.startsWith('#/tables/');
    const result = await put('/api/review/roles', { ...readingJudgment, ref: item.ref, parentRef: item.parentRef || '', region: footnote ? 'footnote' : table ? 'table' : 'body', role: footnote ? 'footnote' : table ? 'table' : 'body' });
    if (result.status !== 200) throw new Error(JSON.stringify(result));
  }
}
export async function seedReading(put, context, judgment = readingJudgment) {
  for (const scope of context.scopes) {
    const result = await put('/api/review/reading-order', { ...judgment, id: scope.id, order: scope.originalOrder });
    if (result.status !== 200) throw new Error(JSON.stringify(result));
  }
  for (const boundary of context.boundaries) {
    const result = await put('/api/review/page-connections', { ...judgment, id: boundary.id, links: [], noConnection: true });
    if (result.status !== 200) throw new Error(JSON.stringify(result));
  }
}
