import { runCodexSuggestions } from './codex-suggestions.mjs';

// Project preferences are independent of source/rule review sessions and revisions.
export function createProjectCodexSettings({ db, cwd, modelRunner, fail }) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_codex_settings (
    id INTEGER PRIMARY KEY CHECK(id=1), model TEXT NOT NULL, effort TEXT NOT NULL,
    version INTEGER NOT NULL, updated_at TEXT NOT NULL);`);
  let connection = { status: 'unchecked', checkedAt: null, models: [], error: null }, controller, task;
  const saved = () => {
    const row = db.prepare('SELECT * FROM project_codex_settings WHERE id=1').get();
    return row ? { model: row.model, effort: row.effort, version: row.version, updatedAt: row.updated_at } : { model: '', effort: '', version: 0, updatedAt: null };
  };
  const snapshot = () => ({ settings: saved(), connection });
  function supported(model, effort) { return connection.models.some(row => row.model === model && row.efforts.includes(effort)); }
  async function check() {
    if (connection.status === 'checking') fail(409, 'Codex 연결을 확인 중입니다.');
    connection = { status: 'checking', checkedAt: null, models: [], error: null };
    controller = new AbortController();
    task = (async () => {
      try {
        const models = await (modelRunner ?? (args => runCodexSuggestions({ ...args, catalogue: true, timeoutMs: 30000 })))({ cwd, signal: controller.signal });
        if (!Array.isArray(models) || !models.length || models.some(row => !row || typeof row.model !== 'string' || !row.model || typeof row.displayName !== 'string' || !Array.isArray(row.efforts) || !row.efforts.length || row.efforts.some(e => typeof e !== 'string' || !e))) throw Error('사용 가능한 모델과 Reasoning effort 목록이 없습니다.');
        if (controller.signal.aborted) throw Error('Codex 연결 확인이 취소되었습니다.');
        // Keep only public model metadata; never persist account or authentication data.
        connection = { status: 'connected', checkedAt: new Date().toISOString(), models: models.map(({ model, displayName, efforts, defaultEffort, isDefault }) => ({ model, displayName, efforts, defaultEffort, isDefault: !!isDefault })), error: null };
      } catch (error) { connection = { status: 'failed', checkedAt: new Date().toISOString(), models: [], error: error.message }; }
      return snapshot();
    })();
    return task;
  }
  function save(body) {
    const current = saved();
    if (body.version !== current.version) fail(409, '프로젝트 설정이 다른 화면에서 변경되었습니다. 최신 설정을 확인하세요.');
    if (Object.keys(body).length !== 3 || !['version', 'model', 'effort'].every(key => Object.hasOwn(body, key)) || typeof body.model !== 'string' || typeof body.effort !== 'string') fail(400, '모델과 Reasoning effort를 선택하세요.');
    if (connection.status !== 'connected') fail(400, '먼저 Codex 연결을 확인하세요.');
    if (!supported(body.model, body.effort)) fail(400, '현재 모델이 지원하는 Reasoning effort를 선택하세요.');
    db.prepare(`INSERT INTO project_codex_settings VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET model=excluded.model,effort=excluded.effort,version=excluded.version,updated_at=excluded.updated_at`).run(body.model, body.effort, current.version + 1, new Date().toISOString());
    return snapshot();
  }
  function resolve(body = {}) {
    const current = saved();
    if (!current.model) return { model: body.model, effort: body.effort }; // Existing clients/defaults before first configuration.
    if ((body.model !== undefined && body.model !== current.model) || (body.effort !== undefined && body.effort !== current.effort)) fail(409, '프로젝트 모델 설정이 변경되었습니다. 설정을 다시 확인하세요.');
    if (connection.status === 'connected' && !supported(current.model, current.effort)) fail(400, '저장된 모델 설정을 현재 모델 목록에서 사용할 수 없습니다. 설정에서 다시 선택하세요.');
    return { model: current.model, effort: current.effort };
  }
  return { snapshot, check, save, resolve, close: async () => { controller?.abort(); await task; } };
}
