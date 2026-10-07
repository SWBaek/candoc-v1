import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { Icon } from './icon';
import { useProjectCodex } from './project-codex-settings';
import type { DocumentInfo, Review, RoleAnnotation, RoleAnnotationGroup, RoleElement } from '@/types';

type Attachment = Pick<RoleAnnotation, 'id' | 'page' | 'comment'>;
type Selection = { stage: number; refs: string[]; page?: number };
type Proposal = Omit<RoleAnnotationGroup, 'changes'> & { changes: (RoleAnnotationGroup['changes'][number] & { text: string; pages: number[] })[]; saved?: { refs: string[]; exceptions: string[]; at: string } };
type Turn = { id: string; message: string; response: string; status: string; error: string | null; stale: boolean; basis: string; model: string; effort: string; attachment: { stage: number; page: number; refs: string[]; annotation: RoleAnnotation | null }; proposals: Proposal[]; queries: { operation: string; total: number | null; count: number; offset: number; nextOffset: number | null }[] };
type Conversation = { conversationId: string | null; currentConversationId: string | null; conversations: { id: string; createdAt: string }[]; total: number; nextOffset: number | null; running: string | null; basis: string; turns: Turn[] };
const empty: Conversation = { conversationId: null, currentConversationId: null, conversations: [], total: 0, nextOffset: null, running: null, basis: '', turns: [] };
const Context = createContext({ open: false, setOpen: (_: boolean) => {}, attachment: null as Attachment | null, attach: (_: Attachment | null) => {}, selection: { stage: 0, refs: [] } as Selection, select: (_: Selection) => {} });
export const useProjectAgent = () => useContext(Context);
export function ProjectAgentProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false), [attachment, setAttachment] = useState<Attachment | null>(null), [selection, setSelection] = useState<Selection>({ stage: 0, refs: [] });
  const attach = useCallback((value: Attachment | null) => { setAttachment(value); if (value) setOpen(true); }, []);
  const select = useCallback((value: Selection) => setSelection(previous => previous.stage === value.stage && previous.page === value.page && JSON.stringify(previous.refs) === JSON.stringify(value.refs) ? previous : value), []);
  return <Context.Provider value={{ open, setOpen, attachment, attach, selection, select }}>{children}</Context.Provider>;
}
async function call<T>(path = '', method = 'GET', body?: object): Promise<T> {
  const res = await fetch('/api/project/agent' + path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const value = await res.json(); if (!res.ok) throw Error(value.error ?? '프로젝트 대화를 읽을 수 없습니다.'); return value;
}
const roles: Record<string, string> = { header: '머리말', footer: '꼬리말', page_number: '페이지 번호', body: '본문', title: '제목', unknown: '미확정' };
export function ProjectAgentPanel({ document: doc, review, dirty, busy, onMutate, onNavigate, onPage }: { document: DocumentInfo; review: Review; dirty: boolean; busy: boolean; onMutate: (url: string, body: object) => Promise<boolean>; onNavigate: (action: () => Promise<void>) => void; onPage: (page: number) => Promise<void> }) {
  const { open, setOpen, attachment, attach, selection } = useProjectAgent(), { state: { settings }, openSettings } = useProjectCodex();
  const [conversation, setConversation] = useState<Conversation>(empty), [message, setMessage] = useState(''), [error, setError] = useState(''), [sending, setSending] = useState(false);
  const [exceptions, setExceptions] = useState<Record<string, string[]>>({}), [approved, setApproved] = useState<Record<string, boolean>>({});
  const [source, setSource] = useState<RoleElement | null>(null), [sourcePage, setSourcePage] = useState(0), [sourceNotice, setSourceNotice] = useState('');
  const [archive, setArchive] = useState('');
  const panel = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null), end = useRef<HTMLDivElement>(null), version = useRef(0), mounted = useRef(true), sourceVersion = useRef(0);
  const [narrow, setNarrow] = useState(window.matchMedia('(max-width: 970px)').matches);
  const currentPage = selection.stage === review.activeStage ? selection.page ?? review.selectedPage : review.selectedPage;
  async function refresh(offset = 0) {
    const seq = ++version.current;
    try {
      const value = await call<Conversation>(`?offset=${offset}${archive ? `&conversationId=${encodeURIComponent(archive)}` : ''}`); if (!mounted.current || seq !== version.current) return;
      setConversation(previous => {
        const old = previous.conversationId === value.conversationId ? previous.turns : [];
        const merged = offset ? [...value.turns, ...old.filter(row => !value.turns.some(item => item.id === row.id))] : [...old.filter(row => !value.turns.some(item => item.id === row.id)), ...value.turns];
        return { ...value, nextOffset: offset ? value.nextOffset : previous.conversationId === value.conversationId && old.length > value.turns.length ? previous.nextOffset : value.nextOffset, turns: merged.map(row => ({ ...row, stale: row.basis !== value.basis || value.conversationId !== value.currentConversationId })) };
      });
    } catch (e) { if (mounted.current) setError((e as Error).message); }
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; version.current++; sourceVersion.current++; }; }, [doc.sourceHash, doc.ruleHash]);
  useEffect(() => { void refresh(); }, [review.revision]);
  useEffect(() => { void refresh(); }, [archive]);
  useEffect(() => { if (!conversation.running) return; const timer = window.setInterval(() => void refresh(), 700); return () => clearInterval(timer); }, [conversation.running]);
  useEffect(() => { if (open) end.current?.scrollIntoView({ block: 'nearest' }); }, [open, conversation.turns.length, conversation.running]);
  useEffect(() => { if (source) panel.current?.querySelector('.project-agent-source')?.scrollIntoView({ block: 'nearest' }); }, [source?.ref]);
  useEffect(() => { if (attachment) setMessage(previous => previous || attachment.comment); }, [attachment?.id]);
  useEffect(() => { const media = window.matchMedia('(max-width: 970px)'), update = () => setNarrow(media.matches); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  useEffect(() => { localStorage.setItem(`candoc-project-agent:${doc.sourceHash}`, open ? 'open' : 'closed'); }, [open, doc.sourceHash]);
  useEffect(() => {
    if (!open) return;
    const previous = globalThis.document.activeElement as HTMLElement | null, shell = globalThis.document.querySelector<HTMLElement>('.app-shell'), wasInert = shell?.inert;
    if (narrow && shell) shell.inert = true;
    close.current?.focus();
    const key = (event: KeyboardEvent) => {
      // A project settings dialog owns keyboard events when it is on top.
      if (globalThis.document.querySelector('.project-settings-modal')) return;
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
      if (event.key !== 'Tab' || !narrow) return;
      const nodes = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),summary')].filter(node => node.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && globalThis.document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    globalThis.document.addEventListener('keydown', key);
    return () => { globalThis.document.removeEventListener('keydown', key); if (narrow && shell) shell.inert = wasInert ?? false; if (previous?.isConnected) previous.focus(); };
  }, [open, narrow]);
  async function send() {
    setSending(true); setError('');
    try {
      const value = await call<Conversation>('', 'POST', { conversationId: conversation.conversationId, sourceHash: doc.sourceHash, ruleHash: doc.ruleHash, revision: review.revision, message, attachment: { stage: review.activeStage, page: attachment?.page ?? currentPage, refs: selection.stage === review.activeStage ? selection.refs.slice(0, 30) : [], ...(attachment ? { annotationId: attachment.id } : {}) } });
      setConversation(value); setMessage(''); attach(null);
    } catch (e) { setError((e as Error).message); }
    finally { setSending(false); }
  }
  function locate(ref: string, preferredPage?: number) {
    onNavigate(async () => {
      const seq = ++sourceVersion.current; setSource(null); setSourceNotice('원본을 읽는 중…');
      try {
        const item = await call<RoleElement>(`/item?ref=${encodeURIComponent(ref)}`); if (!mounted.current || seq !== sourceVersion.current) return;
        const retained = doc.pages.filter(page => review.decisions.find(row => row.page === page.number)?.status !== 'excluded');
        const location = item.provenance.find(prov => prov.page === preferredPage && prov.rect) ?? item.provenance.find(prov => prov.rect && retained.some(page => page.number === prov.page)) ?? item.provenance[0];
        setSource(item); setSourcePage(location?.page ?? 0); setSourceNotice(location?.rect ? '' : '대응 bbox 없음 · 이전 강조를 남기지 않습니다.');
        if (location?.page) await onPage(location.page);
        globalThis.dispatchEvent(new CustomEvent('candoc-agent-locate', { detail: { ref: item.ref, page: location?.page ?? 0 } }));
      } catch (e) { if (seq === sourceVersion.current) setSourceNotice((e as Error).message); }
    });
  }
  async function save(turn: Turn, group: Proposal) {
    const ok = await onMutate('/api/review/agent-proposal', { turnId: turn.id, proposalId: group.id, exceptions: exceptions[group.id] ?? [], sourceHash: doc.sourceHash, ruleHash: doc.ruleHash });
    if (ok) { setApproved(previous => ({ ...previous, [group.id]: false })); await refresh(); }
  }
  const originalPage = doc.pages.find(row => row.number === sourcePage), boxes = source?.provenance.filter(prov => prov.page === sourcePage && prov.rect) ?? [];
  if (!open) return null;
  return createPortal(<><div className="project-agent-backdrop" hidden={!narrow} onClick={() => setOpen(false)} /><aside ref={panel} className="project-agent-panel" role={narrow ? 'dialog' : 'complementary'} aria-modal={narrow || undefined} aria-label="프로젝트 검수 Agent">
    <div className="ai-panel-header"><strong>프로젝트 Agent</strong><Button ref={close} variant="ghost" aria-label="프로젝트 Agent 닫기" onClick={() => setOpen(false)}><Icon name="close" /></Button></div>
    <div className="project-agent-history" aria-label="프로젝트 대화 이력">
      {conversation.nextOffset !== null && <Button variant="ghost" onClick={() => void refresh(conversation.nextOffset!)}>이전 대화 더 보기</Button>}
      {!conversation.turns.length && <p className="project-agent-empty">이 문서를 함께 검수합니다. 원본의 영역을 첨부하거나 현재 페이지에 대해 요청하세요.</p>}
      {conversation.turns.map(turn => <article className="project-agent-turn" key={turn.id}>
        <div className="project-agent-user"><p>{turn.message}</p><small>원본 {turn.attachment.page}페이지 · {turn.attachment.stage}단계{turn.attachment.annotation ? ' · 영역 첨부' : ''}{turn.attachment.refs.length ? ` · 선택 ${turn.attachment.refs.length}개` : ''}</small>{turn.attachment.annotation && <Button variant="ghost" onClick={() => locate(turn.attachment.annotation!.matches[0].ref, turn.attachment.annotation!.page)}>첨부 원본</Button>}</div>
        {turn.status === 'running' ? <p role="status">필요한 문서 범위를 확인하고 있습니다…</p> : turn.status === 'cancelled' || turn.status === 'interrupted' ? <p>응답이 중단되었습니다. 판단은 저장되지 않았습니다.</p> : null}
        {turn.error && <p role="alert">{turn.error}</p>}{turn.response && <p className="project-agent-answer">{turn.response}</p>}
        {turn.proposals.map(group => { const excluded = exceptions[group.id] ?? [], count = group.changes.length - excluded.length; return <section key={group.id} className="project-agent-proposal" aria-label="Agent 변경안"><p>{group.reason}</p>
          {group.saved ? <p role="status">사용자 확인 후 {group.saved.refs.length}개 판단 저장 · 예외 {group.saved.exceptions.length}개</p> : <><p>대상 {group.changes.length}개 · 선택 {count}개 · 예외 {excluded.length}개</p>
          <details><summary>대상·변경 전후·예외</summary>{group.changes.map(change => <div className="project-agent-target" key={change.ref}><label><input type="checkbox" aria-label={`${change.ref} Agent 대상`} checked={!excluded.includes(change.ref)} disabled={busy || turn.stale} onChange={event => { setExceptions(previous => ({ ...previous, [group.id]: event.target.checked ? excluded.filter(ref => ref !== change.ref) : [...excluded, change.ref] })); setApproved(previous => ({ ...previous, [group.id]: false })); }} />{change.text}<small>{change.ref} · 원본 {change.pages.join(', ')}페이지 · {roles[change.before.role] ?? change.before.role} → {roles[change.after.role]} · 소속 유지</small></label><Button variant="ghost" onClick={() => locate(change.ref)}>원본 위치</Button></div>)}</details>
          {turn.stale && <p>검수 판단이 바뀐 변경안입니다. 현재 기록으로 다시 요청하세요.</p>}{dirty && <p>현재 화면의 초안을 저장하거나 취소한 뒤 적용하세요.</p>}
          <div className="record-actions"><Button variant="outline" disabled={busy || dirty || turn.stale || !count} aria-pressed={!!approved[group.id]} onClick={() => setApproved(previous => ({ ...previous, [group.id]: !previous[group.id] }))}>{approved[group.id] ? '승인 취소' : `선택한 ${count}개 승인`}</Button>{approved[group.id] && <Button disabled={busy || dirty || turn.stale} onClick={() => void save(turn, group)}>판단 저장</Button>}</div></>}
        </section>; })}
        {!!turn.queries.length && <details className="project-agent-evidence"><summary>조회 범위 · {turn.queries.length}회</summary>{turn.queries.map((row, i) => <p key={i}>{row.operation} · {row.offset}부터 {row.count}개 / 전체 {row.total ?? '개요'}{row.nextOffset !== null ? ' · 추가 범위 있음' : ''}</p>)}<p>{turn.model} · {turn.effort} · JSON 내부 근거. 응답만으로 검수 완료가 되지 않습니다.</p></details>}
      </article>)}<div ref={end} />
      {(source || sourceNotice) && <section className="project-agent-source" aria-label="Agent 원본 대조"><div className="record-actions"><strong>{source?.ref ?? '원본 대조'}</strong><Button variant="ghost" aria-label="Agent 원본 대조 닫기" onClick={() => { sourceVersion.current++; setSource(null); setSourceNotice(''); }}>닫기</Button></div>{sourceNotice && <p>{sourceNotice}</p>}{source && <>
        <label>원본 출처<select aria-label="Agent 원본 출처 페이지" value={sourcePage} onChange={event => { setSourcePage(Number(event.target.value)); setSourceNotice(''); }}>{[...new Set(source.provenance.map(prov => prov.page))].map(page => <option key={page} value={page}>{page}페이지{review.decisions.find(row => row.page === page)?.status === 'excluded' ? ' · 제외됨' : ''}</option>)}</select></label>
        <div className="role-image-wrap" style={{ aspectRatio: `${originalPage?.width || 1}/${originalPage?.height || 1}` }}>{originalPage?.imageAvailable ? <><img className="role-page-image" src={originalPage.imageUrl} alt={`Agent 대조 원본 ${sourcePage}페이지`} />{boxes.map((prov, i) => <div key={i} className="role-bbox" aria-label="Agent 선택 요소 위치" style={{ left: `${prov.rect!.left * 100}%`, top: `${prov.rect!.top * 100}%`, width: `${prov.rect!.width * 100}%`, height: `${prov.rect!.height * 100}%` }} />)}</> : <p>원문 이미지 없음</p>}</div>{!boxes.length && <p>대응 bbox 없음 · 이전 강조를 남기지 않습니다.</p>}<p>{source.text}</p><details><summary>원본 JSON · 모든 출처</summary><pre>{JSON.stringify(source, null, 2)}</pre></details>
      </>}</section>}
    </div>
    <div className="project-agent-composer">{error && <p role="alert">{error}</p>}
      {attachment ? <div className="project-agent-attachment"><span>{attachment.page}페이지 · 표시 영역 첨부</span><Button variant="ghost" aria-label="영역 첨부 해제" onClick={() => attach(null)}><Icon name="close" /></Button></div> : <small>현재 {review.activeStage}단계 · 원본 {currentPage}페이지{review.activeStage === 2 && review.selectedPages.length ? ` · 선택 ${review.selectedPages.length}페이지` : ''}{selection.stage === review.activeStage && selection.refs.length ? ` · 선택 ${selection.refs.length}개${selection.refs.length > 30 ? ' 중 처음 30개 첨부' : ''}` : ''}</small>}
      {dirty && <small>저장된 검수 기록 기준 · 화면의 미저장 초안은 전달하지 않습니다.</small>}
      {archive && <p>지난 대화 · 읽기 전용</p>}<Textarea aria-label="프로젝트 Agent 메시지" placeholder="이 문서에서 함께 확인할 일을 적어주세요" value={message} maxLength={4000} disabled={!!archive} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && message.trim() && settings.model && !sending && !busy && !conversation.running && !archive) { event.preventDefault(); void send(); } }} />
      <div className="record-actions"><Button variant="ghost" onClick={openSettings}>모델 설정</Button>{conversation.running ? <Button variant="outline" onClick={() => { void call<Conversation>('', 'DELETE', { id: conversation.running }).then(setConversation).catch(e => setError(e.message)); }}>응답 취소</Button> : <Button disabled={sending || busy || !!archive || !message.trim() || !settings.model || !settings.effort} onClick={() => void send()}>보내기</Button>}</div>
      <details className="project-agent-evidence"><summary>대화 관리</summary>{conversation.conversations.length > 1 && <select aria-label="프로젝트 지난 대화" value={archive} onChange={event => setArchive(event.target.value)}><option value="">현재 대화</option>{conversation.conversations.filter(row => row.id !== conversation.currentConversationId).map(row => <option key={row.id} value={row.id}>{new Date(row.createdAt).toLocaleString('ko-KR')}</option>)}</select>}<p>새 대화를 시작해도 이전 대화와 검수 기록은 보존됩니다.</p><Button variant="ghost" disabled={!!archive || !!conversation.running || sending} onClick={() => { void call<Conversation>('/new', 'POST', { conversationId: conversation.conversationId }).then(value => { setConversation(value); setError(''); }).catch(e => setError(e.message)); }}>새 대화 시작</Button></details>
    </div>
  </aside></>, globalThis.document.body);
}
