import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import type { PageSuggestion, SuggestionJob } from '@/types';
import { ProjectCodexLink } from './project-codex-settings';

type Props = { sourceHash: string; ruleHash: string; disabled: boolean; open: boolean; panelHost: HTMLDivElement | null; onOpen: () => void; onClose: () => void; onResult: (suggestions: PageSuggestion[]) => void; onSelect: (pages: number[]) => void };
const endpoint = '/api/review/page-suggestions';

export function PageSuggestions({ sourceHash, ruleHash, disabled, open, panelHost, onOpen, onClose, onResult, onSelect }: Props) {
  const [job, setJob] = useState<SuggestionJob | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 970px)').matches);
  const mounted = useRef(false), requestNumber = useRef(0);
  const resultCallback = useRef(onResult);
  resultCallback.current = onResult;
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  const panelRef = useRef<HTMLElement>(null), closeRef = useRef<HTMLButtonElement>(null), toggleRef = useRef<HTMLButtonElement>(null);
  async function fetchJob(method = 'GET', body?: object) {
    const number = ++requestNumber.current;
    try {
      const response = await fetch(endpoint, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? '추천 결과를 불러올 수 없습니다.');
      if (value.sourceHash !== sourceHash || value.ruleHash !== ruleHash) throw new Error('추천 대상 문서가 바뀌었습니다. 화면을 다시 불러오세요.');
      if (mounted.current && number === requestNumber.current) {
        setJob(value); setError(''); resultCallback.current(value.status === 'completed' ? value.suggestions : []);
      }
    } catch (problem) {
      if (mounted.current && number === requestNumber.current) { setError((problem as Error).message); resultCallback.current([]); }
    }
  }
  useEffect(() => {
    mounted.current = true; void fetchJob();
    return () => { mounted.current = false; requestNumber.current++; };
  }, [sourceHash, ruleHash]);
  useEffect(() => {
    if (job?.status !== 'running' || sending || error) return;
    const timer = window.setTimeout(() => { void fetchJob(); }, 800);
    return () => window.clearTimeout(timer);
  }, [job, sending, error]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 970px)');
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!open || !panelHost) return;
    closeRef.current?.focus();
    const handler = (event: KeyboardEvent) => {
      // Existing image / draft / bulk dialogs take precedence over the AI panel.
      if (window.document.querySelector('.modal-backdrop')) return;
      if (event.key === 'Escape') { event.preventDefault(); closeCallback.current(); }
      if (narrow && event.key === 'Tab') {
        const controls = panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]');
        if (!controls?.length) return;
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); toggleRef.current?.focus(); };
  }, [open, panelHost, narrow]);
  useEffect(() => {
    if (!open || !narrow) return;
    const before = window.document.body.style.overflow;
    window.document.body.style.overflow = 'hidden';
    return () => { window.document.body.style.overflow = before; };
  }, [open, narrow]);
  async function submit(method: 'POST' | 'DELETE') {
    if (method === 'POST') onOpen();
    setSending(true);
    try { await fetchJob(method, method === 'POST' ? {} : { id: job?.id }); }
    finally { if (mounted.current) setSending(false); }
  }
  const suggestions = !error && job?.status === 'completed' ? job.suggestions : [];
  const pages = suggestions.flatMap(item => item.pages);
  const running = job?.status === 'running';
  const status = error ? '' : running ? 'Codex가 전체 페이지를 살펴보고 있습니다…' : job?.status === 'cancelled' ? '추천을 취소했습니다.' : job?.status === 'completed' ? pages.length ? `${pages.length}페이지 제외 후보를 추천합니다.` : '제외할 페이지를 추천하지 않았습니다.' : '';
  const panel = <>
    {narrow && <div className="ai-panel-backdrop" aria-hidden="true" onClick={onClose} />}
    <aside id="ai-response-panel" ref={panelRef} className="ai-response-panel" role={narrow ? 'dialog' : 'complementary'} aria-modal={narrow ? true : undefined} aria-label="AI 응답 패널">
      <div className="ai-panel-header"><div><Icon name="chat" /><strong>AI 검수</strong><span>페이지 선별</span></div><Button size="icon" variant="ghost" ref={closeRef} aria-label="AI 응답 닫기" onClick={onClose}><Icon name="close" /></Button></div>
      <section className="ai-conversation" aria-label="AI 페이지 제외 추천" tabIndex={0}>
        {job?.id ? <>
          <div className="ai-user-message"><span>요청</span><p>표지·목차·참여자 목록처럼 불필요한 페이지를 추천해줘.</p></div>
          <div className="ai-agent-message"><strong className="ai-speaker">Codex</strong>{status && <p className="ai-response-status" role="status">{status}</p>}
            {(error || job.error) && <div className="ai-suggestion-error" role="alert"><p>{error || job.error}</p>{error && <Button size="sm" variant="outline" disabled={sending} onClick={() => void fetchJob()}>추천 상태 다시 확인</Button>}</div>}
            {suggestions.map(item => <div className="ai-suggestion-row" key={item.pages.join(',')}><strong>원본 {item.pages.join(', ')}페이지</strong><p>{item.reason}</p><Button size="sm" variant="outline" disabled={disabled || sending} onClick={() => onSelect(item.pages)} aria-label={`추천 원본 ${item.pages.join(', ')}페이지 선택`}>이 페이지 선택</Button></div>)}
          </div>
        </> : <div className="ai-welcome"><Icon name="chat" /><strong>페이지 선별을 함께 시작하세요.</strong><p>표지·목차·참여자 목록 등 제외할 만한 페이지와 이유를 추천합니다.</p>{error && <p className="ai-suggestion-error" role="alert">{error}</p>}</div>}
      </section>
      <div className="ai-panel-actions">
        <ProjectCodexLink />
        {pages.length > 0 && <Button size="sm" disabled={disabled || sending} onClick={() => onSelect(pages)}>추천 전체 선택</Button>}
        {running ? <Button size="sm" variant="outline" disabled={sending} onClick={() => void submit('DELETE')}>{sending ? '취소 중…' : '추천 취소'}</Button> : <Button size="sm" variant="outline" disabled={disabled || sending} onClick={() => void submit('POST')}>{job?.id ? '다시 추천' : '페이지 추천 시작'}</Button>}
        <p>선택한 페이지는 기존 ‘제외’ 버튼에서 사유를 확인하고 저장하세요.</p>
      </div>
    </aside>
  </>;
  return <div className="ai-suggestion-tools">
    <Button size="sm" variant="outline" title="표지·목차·참여자 목록 등을 추천합니다." disabled={disabled || sending || running} onClick={() => void submit('POST')}><Icon name="chat" />AI 제외 추천</Button>
    <Button size="sm" variant="ghost" ref={toggleRef} aria-label={open ? 'AI 응답 패널 닫기' : 'AI 응답 열기'} aria-expanded={open} aria-controls="ai-response-panel" onClick={open ? onClose : onOpen}>AI 응답{running ? ' · 추천 중' : pages.length ? ` · ${pages.length}` : ''}</Button>
    {open && panelHost && createPortal(panel, panelHost)}
  </div>;
}
