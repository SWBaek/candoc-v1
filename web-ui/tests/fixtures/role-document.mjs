export function roleDocument() {
  const bbox = (l, t, r, b) => ({ l, t, r, b, coord_origin: 'BOTTOMLEFT' });
  const text = (index, value, page, box, label = 'text') => ({ self_ref: `#/texts/${index}`, parent: { $ref: '#/body' }, children: [], content_layer: 'body', label, text: value, orig: value, prov: page ? [{ page_no: page, bbox: box, charspan: [0, value.length] }] : [] });
  const texts = [text(0, 'Report  Header', 1, bbox(10, 96, 80, 92), 'page_header'), text(1, 'report header', 2, bbox(10, 95, 80, 91), 'section_header'), text(2, 'REPORT HEADER', 3, bbox(10, 96, 80, 92), 'text'), text(3, '1', 1, bbox(48, 8, 52, 4), 'page_footer'), text(4, '2', 2, bbox(48, 8, 52, 4), 'page_footer'), text(5, 'iii', 3, bbox(47, 8, 53, 4), 'page_footer'), text(6, 'Real document title', 1, bbox(10, 70, 80, 55), 'section_header'), text(7, 'Important footnote content', 2, bbox(10, 20, 80, 12), 'footnote'), text(8, 'Unlocated content', 0), text(9, 'Report Header', 2, bbox(10, 96, 80, 92), 'page_header')];
  texts[9].prov.push({ page_no: 4, bbox: bbox(10, 96, 80, 92), charspan: [2, 10] });
  return { schema_name: 'DoclingDocument', version: '1.10.0', name: 'Synthetic role review fixture', body: { self_ref: '#/body', children: texts.map(text => ({ $ref: text.self_ref })) }, furniture: { self_ref: '#/furniture', children: [] }, texts,
    tables: [{ self_ref: '#/tables/0', label: 'table', parent: { $ref: '#/body' }, prov: [{ page_no: 2, bbox: bbox(10, 80, 80, 40) }], data: { table_cells: [{ text: 'A table cell', start_row_offset_idx: 0, start_col_offset_idx: 0 }] } }],
    pictures: [{ self_ref: '#/pictures/0', label: 'picture', parent: { $ref: '#/body' }, prov: [{ page_no: 3, bbox: bbox(10, 80, 80, 40) }] }],
    groups: [{ self_ref: '#/groups/0', label: 'list', parent: { $ref: '#/body' }, children: [{ $ref: '#/texts/7' }] }, { self_ref: '#/groups/1', label: 'unspecified', parent: { $ref: '#/body' }, children: [] }],
    pages: Object.fromEntries([1, 2, 3, 4].map(page => [page, { page_no: page, size: { width: 100, height: 100 }, image: { uri: 'artifacts/page.png' } }])) };
}
export const pixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZekAAAAASUVORK5CYII=', 'base64');
