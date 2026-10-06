import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';

type Model = { model: string; displayName: string; efforts: string[]; defaultEffort?: string; isDefault: boolean };
type Settings = { model: string; effort: string; version: number; updatedAt: string | null };
type State = { settings: Settings; connection: { status: 'unchecked' | 'checking' | 'connected' | 'failed'; checkedAt: string | null; models: Model[]; error: string | null } };
const initial: State = { settings: { model: '', effort: '', version: 0, updatedAt: null }, connection: { status: 'unchecked', checkedAt: null, models: [], error: null } };
const Context = createContext({ state: initial, openSettings: () => {} });
export const useProjectCodex = () => useContext(Context);
const endpoint = '/api/project/codex';
async function call(method = 'GET', body?: object, check = false): Promise<State> {
  const response = await fetch(endpoint + (check ? '/check' : ''), { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  // Connection failures include the current saved preferences and an explicit failed status.
  if (!response.ok && !(check && value.connection?.status === 'failed')) throw Error(value.error ?? '프로젝트 설정을 불러올 수 없습니다.');
  return value;
}
export function ProjectCodexProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initial), [open, setOpen] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(initial.settings);
  const dialog = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(busy); busyRef.current = busy;
  useEffect(() => { let active = true; void call().then(value => { if (active) setState(value); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, []);
  function openSettings() { setDraft(state.settings); setOpen(true); }
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null, shell = document.querySelector<HTMLElement>('.app-shell'), wasInert = shell?.inert;
    if (shell) shell.inert = true;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; closeButton.current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!busyRef.current) setOpen(false); }
      if (event.key !== 'Tab') return;
      const controls = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled)')].filter(node => node.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handler, true);
    return () => { document.removeEventListener('keydown', handler, true); if (shell) shell.inert = wasInert ?? false; document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, [open]);
  async function check() {
    setBusy(true); setError('');
    try {
      const value = await call('POST', {}, true); setState(value);
      if (!draft.model && value.connection.status === 'connected') {
        const first = value.connection.models.find(row => row.isDefault) ?? value.connection.models[0];
        const effort = first.efforts.includes(first.defaultEffort ?? '') ? first.defaultEffort! : first.efforts[0];
        setDraft({ ...value.settings, model: first.model, effort });
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError('');
    try { const value = await call('PUT', { version: draft.version, model: draft.model, effort: draft.effort }); setState(value); setOpen(false); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function refresh() { setBusy(true); try { setState(await call()); setError('최신 저장 설정을 확인했습니다. 현재 초안은 유지됩니다. 취소 후 다시 열면 저장값을 불러옵니다.'); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const model = state.connection.models.find(row => row.model === draft.model), supported = !!model?.efforts.includes(draft.effort);
  const status = busy ? '처리 중…' : state.connection.status === 'connected' ? 'Codex 연결 확인됨' : state.connection.status === 'failed' ? 'Codex 연결 실패' : state.connection.status === 'checking' ? 'Codex 연결 확인 중…' : 'Codex 연결 미확인';
  return <Context.Provider value={{ state, openSettings }}>{children}{open && createPortal(<div className="modal-backdrop project-settings-backdrop"><div ref={dialog} className="project-settings-modal" role="dialog" aria-modal="true" aria-labelledby="project-settings-title">
    <div className="project-settings-header"><h2 id="project-settings-title">프로젝트 설정</h2><Button ref={closeButton} size="icon" variant="ghost" aria-label="설정 닫기" disabled={busy} onClick={() => setOpen(false)}><Icon name="close" /></Button></div>
    <div className="project-codex-connection"><div><strong>Codex</strong><p role="status">{status}</p></div><Button variant="outline" disabled={busy || state.connection.status === 'checking'} onClick={() => void check()}>연결 확인</Button></div>
    <p className="project-settings-note">로컬 Codex의 로그인과 모델 목록을 확인합니다. 모델은 실행하지 않습니다.{state.connection.checkedAt && <> 최근 확인: {new Date(state.connection.checkedAt).toLocaleTimeString('ko-KR')}</>}</p>
    {state.connection.error && <p role="alert">{state.connection.error}</p>}
    <label className="project-settings-field">모델<select aria-label="프로젝트 모델" value={draft.model} disabled={busy || state.connection.status !== 'connected'} onChange={event => { const row = state.connection.models.find(row => row.model === event.target.value)!; setDraft({ ...draft, model: row.model, effort: row.efforts.includes(draft.effort) ? draft.effort : row.efforts.includes(row.defaultEffort ?? '') ? row.defaultEffort! : row.efforts[0] }); }}><option value="" disabled>연결 확인 후 선택</option>{draft.model && !model && <option value={draft.model}>{draft.model} · 저장값</option>}{state.connection.models.map(row => <option key={row.model} value={row.model}>{row.displayName}</option>)}</select></label>
    <label className="project-settings-field">Reasoning effort<select aria-label="프로젝트 Reasoning effort" value={draft.effort} disabled={busy || !model || state.connection.status !== 'connected'} onChange={event => setDraft({ ...draft, effort: event.target.value })}><option value="" disabled>effort 선택</option>{draft.effort && !supported && <option value={draft.effort}>{draft.effort} · 저장값</option>}{model?.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>
    {state.connection.status === 'connected' && draft.model && !supported && <p role="alert">저장된 모델·effort를 현재 목록에서 사용할 수 없습니다. 다시 선택하세요.</p>}
    <p className="project-settings-note">이 프로젝트의 페이지·목차·영역 추천에 함께 사용합니다. 실행 중인 요청은 기존 설정으로 계속됩니다.</p>
    {error && <div role="alert"><p>{error}</p><Button variant="outline" disabled={busy} onClick={() => void refresh()}>최신 설정 확인</Button></div>}
    <div className="prompt-actions"><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>취소</Button><Button disabled={busy || state.connection.status !== 'connected' || !supported || (draft.model === state.settings.model && draft.effort === state.settings.effort)} onClick={() => void save()}>설정 저장</Button></div>
  </div></div>, document.body)}</Context.Provider>;
}
export function ProjectCodexLink() {
  const { state: { settings }, openSettings } = useProjectCodex();
  return <Button variant="ghost" className="project-codex-link" onClick={openSettings}>{settings.model ? `${settings.model} · ${settings.effort}` : '프로젝트 모델 설정'}</Button>;
}
