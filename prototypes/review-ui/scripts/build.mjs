import { build } from "esbuild"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
await mkdir(path.join(root, "dist"), { recursive: true })
const css = spawnSync(process.execPath, ["node_modules/@tailwindcss/cli/dist/index.mjs", "-i", "src/styles.css", "-o", "dist/style.css", "--minify"], { cwd: root, encoding: "utf8" })
if (css.status !== 0) throw new Error(css.stderr)
await build({absWorkingDir: root, entryPoints: ["src/main.tsx"], outfile: "dist/app.js", bundle: true, minify: true, format: "iife", target: "es2022", define: {"process.env.NODE_ENV": '"production"'}, jsx: "automatic"})
const markup = await readFile(path.join(root, "fragment-template.html"), "utf8")
const style = await readFile(path.join(root, "dist/style.css"), "utf8")
const script = (await readFile(path.join(root, "dist/app.js"), "utf8")).replaceAll("</script", "<\\/script")
const fragment = `${markup}\n<style>\n${style}\n</style>\n<script>\n${script}\n</script>\n`
if (Buffer.byteLength(fragment) >= 1000000) throw new Error("Inline mockup exceeds 1 MB")
await writeFile(path.join(root, "review-ui-variants.html"), fragment)
const standalone = `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CanDoc · 검수 UI 시안</title><style>body{margin:0;padding:24px;background:light-dark(#f5f5f5,#171717);color-scheme:light dark;font-family:system-ui,sans-serif}.local-variant-picker{display:flex;gap:8px;flex-wrap:wrap;margin:0 auto 16px;max-width:1200px}.local-variant-picker button{border:1px solid light-dark(#ddd,#444);background:light-dark(#fff,#222);color:light-dark(#222,#eee);border-radius:6px;padding:9px 14px;font:inherit}.local-variant-picker button[aria-pressed=true]{background:light-dark(#18181b,#eee);color:light-dark(#fff,#18181b)}</style></head><body><nav class="local-variant-picker" aria-label="시안 선택"><button data-show="3단 작업대" aria-pressed="true">3단 작업대</button><button data-show="원문 중심" aria-pressed="false">원문 중심</button><button data-show="단계별 집중" aria-pressed="false">단계별 집중</button></nav>${fragment}<script>document.querySelectorAll('[data-show]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-variant]').forEach(section=>section.hidden=section.dataset.variant!==button.dataset.show);document.querySelectorAll('[data-show]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)))}))</script></body></html>`
await writeFile(path.join(root, "dist/index.html"), standalone)
console.log(`Built 3 shadcn/ui mockups, ${Buffer.byteLength(fragment)} bytes; self-contained preview.`)
