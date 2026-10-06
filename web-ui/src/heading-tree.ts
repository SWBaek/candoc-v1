import type { HeadingDraft } from './types';
import { validateHeadingForest } from '../server/heading-tree.mjs';
export function descendants(ref: string, rows: HeadingDraft[]) {
  const result = new Set<string>([ref]); let added = true;
  while (added) { added = false; for (const row of rows) if (row.isHeading && result.has(row.parentRef) && !result.has(row.ref)) { result.add(row.ref); added = true; } }
  return result;
}
export function treeRows(rows: HeadingDraft[]) {
  const result: HeadingDraft[] = [], seen = new Set<string>(), map = new Map(rows.map(row => [row.ref, row]));
  function append(parent: string) { for (const row of [...rows].sort((a, b) => a.position - b.position || a.ref.localeCompare(b.ref))) if (!seen.has(row.ref) && (row.isHeading && map.get(row.parentRef)?.isHeading ? row.parentRef : '') === parent) { seen.add(row.ref); result.push(row); append(row.ref); } }
  append(''); for (const row of rows) if (!seen.has(row.ref)) result.push(row); return result;
}
export function visibleTree(rows: HeadingDraft[], texts: Map<string, string>, query: string, collapsed: Set<string>) {
  const ordered = treeRows(rows), map = new Map(rows.map(row => [row.ref, row])), wanted = new Set<string>(), direct = new Set<string>();
  if (query.trim()) for (const row of ordered) if (`${row.ref} ${texts.get(row.ref) ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())) { direct.add(row.ref); let ref = row.ref; const seen = new Set<string>(); while (map.has(ref) && !seen.has(ref)) { seen.add(ref); wanted.add(ref); ref = map.get(ref)!.parentRef; } }
  return ordered.filter(row => { if (query.trim()) return wanted.has(row.ref); let parent = row.parentRef; const seen = new Set<string>(); while (map.has(parent) && !seen.has(parent)) { if (collapsed.has(parent)) return false; seen.add(parent); parent = map.get(parent)!.parentRef; } return true; }).map(row => ({ row, context: !!query.trim() && !direct.has(row.ref) }));
}
export function changeHierarchy(rows: HeadingDraft[], ref: string, parentRef: string) {
  const node = rows.find(row => row.ref === ref), parent = rows.find(row => row.ref === parentRef);
  if (!node?.isHeading || parentRef && !parent?.isHeading) throw Error('제목 여부를 먼저 판단하고 제목 부모를 선택하세요.');
  const subtree = descendants(ref, rows); if (subtree.has(parentRef)) throw Error('자기 자신이나 하위 제목을 부모로 선택할 수 없습니다.');
  const level = parentRef ? parent!.level! + 1 : 1, delta = level - node.level!;
  if (rows.some(row => subtree.has(row.ref) && (row.level! + delta < 1 || row.level! + delta > 9))) throw Error('하위 트리 깊이는 1~9 범위여야 합니다.');
  const ordered = treeRows(rows), block = ordered.filter(row => subtree.has(row.ref)), rest = ordered.filter(row => !subtree.has(row.ref));
  let insertion = rest.length;
  if (parentRef) { const family = descendants(parentRef, rest); insertion = Math.max(...rest.map((row, index) => family.has(row.ref) ? index : -1)) + 1; }
  else if (node.parentRef) { const family = descendants(node.parentRef, rest); insertion = Math.max(...rest.map((row, index) => family.has(row.ref) ? index : -1)) + 1; }
  rest.splice(insertion, 0, ...block);
  // Preserve gaps and unrelated positions. Only a moved subtree receives new
  // positions when its relative order changes.
  const positions = new Map<string, number>();
  if (ordered.filter(row => row.isHeading).map(row => row.ref).join('|') !== rest.filter(row => row.isHeading).map(row => row.ref).join('|')) {
    const first = rest.findIndex(row => subtree.has(row.ref));
    const preceding = rest.slice(0, first).filter(row => row.isHeading).at(-1)?.position ?? -1;
    const following = rest.slice(first + block.length).find(row => row.isHeading)?.position ?? preceding + block.length + 1;
    block.forEach((row, index) => positions.set(row.ref, preceding + (following - preceding) * (index + 1) / (block.length + 1)));
  }
  const result = rest.map(row => subtree.has(row.ref) ? { ...row, position: positions.get(row.ref) ?? row.position, level: row.level! + delta, parentRef: row.ref === ref ? parentRef : row.parentRef, part: parentRef ? parent!.part : row.part } : row);
  validateHeadingForest(result, (_, message) => { throw Error(message); });
  return result;
}
export function indentTree(rows: HeadingDraft[], ref: string, outward: boolean) {
  const node = rows.find(row => row.ref === ref); if (!node?.isHeading) throw Error('제목 여부를 먼저 판단하세요.');
  if (outward) { const parent = rows.find(row => row.ref === node.parentRef); if (!parent) throw Error('최상위 제목은 더 내어쓸 수 없습니다.'); return changeHierarchy(rows, ref, parent.parentRef); }
  const siblings = treeRows(rows).filter(row => row.isHeading && row.parentRef === node.parentRef), index = siblings.findIndex(row => row.ref === ref), previous = siblings[index - 1];
  if (!previous) throw Error('앞의 형제 제목이 있어야 들여쓸 수 있습니다.'); return changeHierarchy(rows, ref, previous.ref);
}
