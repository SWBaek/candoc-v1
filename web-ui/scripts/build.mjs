import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'dist'), { recursive: true });
const css = spawnSync(process.execPath, ['node_modules/@tailwindcss/cli/dist/index.mjs', '-i', 'src/styles.css', '-o', 'dist/app.css', '--minify'], { cwd: root, encoding: 'utf8' });
if (css.status !== 0) throw new Error(css.stderr);
await build({ absWorkingDir: root, entryPoints: ['src/main.tsx'], outfile: 'dist/app.js', bundle: true, minify: true, format: 'iife', target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
await copyFile(path.join(root, 'index.html'), path.join(root, 'dist/index.html'));
console.log('Built CanDoc local review UI.');
