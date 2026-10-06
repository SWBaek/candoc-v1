export { pixelPng } from './role-document.mjs';
export const judgment = { status: 'normal', reason: '원문과 구조 대조', followUp: '', evidence: 'json' };
export function headingDocument() {
  const texts = ['1 Alpha', '2 Beta', '3 Gamma', 'Long prose '.repeat(30), 'Running document header', 'Annex A Extra'].map((text, i) => ({ self_ref: `#/texts/${i}`, label: [0, 1, 5].includes(i) ? 'section_header' : 'text', level: [0, 1, 5].includes(i) ? 1 : undefined, parent: { $ref: '#/body' }, children: [], orig: text, text, prov: [{ page_no: i === 5 ? 2 : 1, bbox: { l: 10, t: 90 - i * 10, r: 90, b: 84 - i * 10, coord_origin: 'BOTTOMLEFT' }, charspan: [0, text.length] }] }));
  texts[5].prov.push({ page_no: 3, bbox: { l: 10, t: 90, r: 90, b: 84, coord_origin: 'BOTTOMLEFT' }, charspan: [2, 7] });
  return { schema_name: 'DoclingDocument', version: '1.10.0', name: 'Synthetic TOC review', texts, tables: [], pictures: [], groups: [], body: { self_ref: '#/body', children: texts.map(row => ({ $ref: row.self_ref })) }, furniture: { self_ref: '#/furniture', children: [] }, pages: Object.fromEntries([1, 2, 3].map(page => [page, { page_no: page, size: { width: 100, height: 100 }, image: { uri: 'artifacts/page.png' } }])) };
}
export function headingPayload(item, options = {}) { return { ref: item.ref, ...judgment, isHeading: true, level: 1, parentRef: '', sectionNumber: item.numberHint ?? '', part: item.ref === '#/texts/5' ? 'appendix' : 'body', position: item.readingIndex ?? 0, ...options }; }
export function nonHeading(item, options = {}) { return headingPayload(item, { isHeading: false, level: null, parentRef: '', sectionNumber: '', part: '', ...options }); }
export async function seedOutline(put, context, uncertainty = false) {
  const items = context.candidates.map(item => nonHeading(item, uncertainty ? { status: 'unjudgeable', followUp: '원문 제목 여부 확인' } : {}));
  const pages = context.pageScopes.map(row => ({ page: row.page, ...judgment, part: uncertainty ? 'unknown' : 'body', checkedAllText: true, issues: [], ...(uncertainty ? { status: 'unjudgeable', followUp: '전체 문서 구분과 누락 대조' } : {}) }));
  const result = await put('/api/review/headings', { action: 'save', items, pages }); if (result.status !== 200) throw new Error(JSON.stringify(result)); return result.data;
}
