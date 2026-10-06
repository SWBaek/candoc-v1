import test from 'node:test';
import assert from 'node:assert/strict';
import { indentTree, visibleTree, changeHierarchy, treeRows } from '../src/heading-tree.ts';
import { validateHeadingForest } from '../server/heading-tree.mjs';
const rows = () => [{ ref: 'A', isHeading: true, level: 1, parentRef: '', part: 'body', position: 0 }, { ref: 'B', isHeading: true, level: 1, parentRef: '', part: 'body', position: 1 }, { ref: 'C', isHeading: true, level: 2, parentRef: 'B', part: 'body', position: 2 }, { ref: 'D', isHeading: true, level: 1, parentRef: '', part: 'body', position: 3 }];
const check = values => validateHeadingForest(values, (_, message) => { throw Error(message); });
test('indent/outdent moves parent and entire subtree depths/preorder coherently; illegal parents reject', () => {
  const initial = rows(), indented = indentTree(initial, 'B', false); check(indented);
  assert.equal(indented.find(row => row.ref === 'B').parentRef, 'A'); assert.equal(indented.find(row => row.ref === 'C').level, 3); assert.deepEqual(treeRows(indented).map(row => row.ref), ['A', 'B', 'C', 'D']);
  const outward = indentTree(indented, 'B', true); check(outward); assert.deepEqual(outward, initial);
  const changed = changeHierarchy(initial, 'B', 'D'); check(changed); assert.deepEqual(treeRows(changed).map(row => row.ref), ['A', 'D', 'B', 'C']);
  assert.throws(() => changeHierarchy(initial, 'B', 'C'), /하위/); assert.throws(() => indentTree(initial, 'A', false), /형제/);
});
test('search retains ancestors; collapsed hidden selections can be identified without editing source', () => {
  const values = rows(), text = new Map(values.map(row => [row.ref, row.ref === 'C' ? 'Find me' : row.ref]));
  assert.deepEqual(visibleTree(values, text, '', new Set(['B'])).map(({ row }) => row.ref), ['A', 'B', 'D']);
  const searched = visibleTree(values, text, 'find', new Set(['B'])); assert.deepEqual(searched.map(({ row }) => row.ref), ['B', 'C']); assert.equal(searched[0].context, true); assert.equal(searched[1].context, false); assert.deepEqual(values, rows());
});
