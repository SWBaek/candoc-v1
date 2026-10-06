import { roleDocument } from './role-document.mjs';
export function roleAnnotationDocument() {
  const doc = roleDocument();
  for (const [value, box] of [['Report', { l: 10, r: 80, t: 5, b: 8 }], ['Header', { l: 38, r: 52, t: 9, b: 12 }], ['1.3 Purpose', { l: 10, r: 40, t: 14, b: 19 }]]) {
    const index = doc.texts.length;
    doc.texts.push({ self_ref: `#/texts/${index}`, parent: { $ref: '#/body' }, children: [], content_layer: 'body', label: 'section_header', text: value, orig: value, prov: [{ page_no: 4, bbox: { ...box, coord_origin: 'TOPLEFT' }, charspan: [0, value.length] }] });
    doc.body.children.push({ $ref: `#/texts/${index}` });
  }
  return doc;
}
