import { createReviewApp } from './app.mjs';

const args = process.argv.slice(2);
const allowed = ['--port', '--project', '--db'];
const values = {};
for (let i = 0; i < args.length; i += 2) {
  if (!allowed.includes(args[i]) || !args[i + 1]) throw new Error('사용법: npm start -- [--port 4380] [--project <문서 폴더>] [--db <SQLite 파일>]');
  values[args[i]] = args[i + 1];
}
const port = Number(values['--port'] ?? 4380);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('유효한 포트 번호가 필요합니다.');
const app = createReviewApp({ projectDir: values['--project'], dbPath: values['--db'] });
app.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
app.server.listen(port, '127.0.0.1', () => console.log(`CanDoc Local: http://127.0.0.1:${port}\n${app.source ? `문서: ${app.source.metadata.name} · ${app.source.pages.length} pages\n검수 DB: ${app.dbPath}` : '입력 파일을 열 수 없습니다. 검수 화면에서 안내를 확인하세요.'}`));
let closing = false;
async function shutdown() { if (closing) return; closing = true; await app.close(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
