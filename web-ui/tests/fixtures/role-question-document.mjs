import { roleDocument } from './role-document.mjs';
export function roleQuestionDocument() {
  const document = roleDocument();
  for (const [text, page] of [['Figure 3 — Test circuit', 3], ['Table 1 — Measured values', 2], ['Figure 9 — No nearby image', 4], ['Institute of Technology', 4]]) {
    const index = document.texts.length;
    document.texts.push({ self_ref: `#/texts/${index}`, parent: { $ref: '#/body' }, children: [], content_layer: 'body', label: 'text', text, orig: text, prov: [{ page_no: page, bbox: { l: 10, r: 80, t: 35, b: 30, coord_origin: 'BOTTOMLEFT' }, charspan: [0, text.length] }] });
    document.body.children.push({ $ref: `#/texts/${index}` });
  }
  return document;
}
