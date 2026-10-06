import { build } from "esbuild"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
await mkdir(path.join(root, "dist"), { recursive: true })
const css = spawnSync(process.execPath, ["node_modules/@tailwindcss/cli/dist/index.mjs", "-i", "src/workflow.css", "-o", "dist/workflow.css", "--minify"], { cwd: root, encoding: "utf8" })
if (css.status !== 0) throw new Error(css.stderr)
await build({absWorkingDir: root, entryPoints: ["src/workflow.tsx"], outfile: "dist/workflow.js", bundle: true, minify: true, format: "iife", target: "es2022", define: {"process.env.NODE_ENV": '"production"'}, jsx: "automatic"})
const markup = await readFile(path.join(root, "workflow-fragment-template.html"), "utf8")
const style = await readFile(path.join(root, "dist/workflow.css"), "utf8")
const script = (await readFile(path.join(root, "dist/workflow.js"), "utf8")).replaceAll("</script", "<\\/script")
const fragment = `${markup}\n<style>\n${style}\n</style>\n<script>\n${script}\n</script>\n`
if (Buffer.byteLength(fragment) >= 1000000) throw new Error("Inline mockup exceeds 1 MB")
await writeFile(path.join(root, "review-workflow.html"), fragment)
const standalone = `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CanDoc · 전체 검수 과정</title><style>body{margin:0;color-scheme:light dark;background:light-dark(#fff,#19191b)}#candoc-review-workflow{max-width:1600px;margin:auto}</style></head><body>${fragment}</body></html>`
await writeFile(path.join(root, "dist/workflow.html"), standalone)
console.log(`Built workflow prototype, ${Buffer.byteLength(fragment)} bytes; original inputs unchanged.`)
