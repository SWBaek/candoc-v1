// Positions describe the proposal's preorder, independently of source labels,
// printed numbering and Docling parent pointers.
export function validateHeadingForest(rows, fail) {
  const headings = rows.filter(row => row.isHeading && !row.needsReview).sort((a, b) => a.position - b.position);
  const map = new Map(headings.map(row => [row.ref, row])), positions = new Set(), stack = [];
  for (const row of headings) {
    if (positions.has(row.position)) fail(400, '제안 제목의 위치가 중복됩니다.'); positions.add(row.position);
    const ancestors = new Set([row.ref]); let parent = row.parentRef;
    while (parent) { if (ancestors.has(parent)) fail(400, '제안 제목 계층에 순환이 있습니다.'); ancestors.add(parent); const node = map.get(parent); if (!node) fail(400, '제안 제목의 부모가 없거나 비제목/미확정입니다.'); parent = node.parentRef; }
    if (!Number.isInteger(row.level) || row.level < 1 || row.level > 9) fail(400, '제안 제목의 깊이는 1~9여야 합니다.');
    if (!row.parentRef && row.level !== 1) fail(400, '최상위 제목은 깊이 1이어야 합니다.');
    if (row.parentRef) {
      const parent = map.get(row.parentRef);
      if (parent.position >= row.position) fail(400, '제안 제목의 부모가 자식보다 뒤에 있습니다.');
      if (parent.level + 1 !== row.level || parent.part !== row.part) fail(400, '제안 제목의 부모·깊이·문서 구분이 일치하지 않습니다.');
      if (stack[row.level - 2]?.ref !== row.parentRef) fail(400, '제안 제목의 하위 트리가 연속하지 않습니다.');
    }
    stack.length = row.level - 1; stack.push(row);
  }
}
