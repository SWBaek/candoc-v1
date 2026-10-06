import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.resolve(root, process.env.CANDOC_BUILD_DIR ?? 'dist');
await mkdir(outputDir, { recursive: true });
const css = spawnSync(process.execPath, ['node_modules/@tailwindcss/cli/dist/index.mjs', '-i', 'src/styles.css', '-o', path.join(outputDir, 'app.css'), '--minify'], { cwd: root, encoding: 'utf8' });
if (css.status !== 0) throw new Error(css.stderr);
await build({ absWorkingDir: root, entryPoints: ['src/main.tsx'], outfile: path.join(outputDir, 'app.js'), bundle: true, minify: true, format: 'iife', target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
await copyFile(path.join(root, 'index.html'), path.join(outputDir, 'index.html'));
console.log('Built CanDoc local review UI.');
