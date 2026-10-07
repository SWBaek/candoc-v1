import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Icon, type IconName } from '@/components/icon';
import { PageSuggestions } from '@/components/page-suggestions';
import { RoleReview, type RoleReviewHandle } from '@/components/role-question-review';
import { HeadingReview } from '@/components/heading-review';
import { ReadingReview } from '@/components/reading-review';
import { ProjectCodexProvider, useProjectCodex } from '@/components/project-codex-settings';
import { ProjectAgentPanel, ProjectAgentProvider, useProjectAgent } from '@/components/project-agent';
import type { DecisionStatus, DocumentInfo, ElementInfo, Evidence, PageDecision, PageInfo, PageSuggestion, Review, Stage } from './types';

const labels: Record<DecisionStatus, string> = { unreviewed: '미검수', included: '포함', excluded: '제외', pending: '보류' };
const stageIcons: IconName[] = ['document', 'shield', 'pages', 'layout', 'order', 'heading', 'link', 'paragraph', 'list', 'table', 'type', 'compare', 'record'];
const stageHints = [
  '', // Stored legacy stage 0 is now the document-info view.
  '', // Stored legacy stage 1 is no longer a user review step.
  '원문 페이지 이미지를 보며 포함·제외·보류를 판단하세요. 표지나 목차를 자동으로 제외하지 않습니다.',
  '반복 요소와 분류 의심을 질문으로 확인하고, 나머지는 페이지별로 훑어보세요.',
  '영역 내 읽기 순서와 페이지를 넘어 이어지는 문단·표·각주의 연결을 확인하세요.',
  '전체 목차에서 의심 항목을 확인하고 계층을 조정하세요.',
  '캡션·각주·주석과 본문 참조가 관련 표·그림·요소에 올바르게 연결됐는지 확인하세요.',
  '역할과 소속을 근거로 문단 분리·병합, 줄바꿈·하이픈과 페이지 경계의 문장 연결을 확인하세요.',
  '목록 여부와 항목 표시·번호 순서·중첩 관계를 확인하세요.',
  '표의 행·열·헤더·셀 범위·병합·충돌과 그림 내부 텍스트의 소속을 확인하세요.',
  'orig·text·marker와 주변 설명을 대조해 기호·변수·단위와 내부 의미의 일관성을 확인하세요.',
  '제목·소속·참조·번호 체계와 앞선 판단 사이의 충돌을 확인하세요.',
  '검사 범위와 정상·오류 확인·의심·판단 불가를 기록하세요. 검수와 교정 완료는 구분합니다.'
];
async function request<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, body ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '검수 기록을 불러올 수 없습니다.');
  return result;
}
type Draft = Pick<PageDecision, 'status' | 'reason' | 'note' | 'evidence'>;
const draftOf = (decision: PageDecision, page: PageInfo): Draft => ({ status: decision.status, reason: decision.reason, note: decision.note, evidence: decision.evidence || (page.imageAvailable ? 'page_image' : 'json') });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function App() {
  const { openSettings } = useProjectCodex();
  const projectAgent = useProjectAgent();
  const [document, setDocument] = useState<DocumentInfo | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const reviewRef = useRef<Review | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [stageNote, setStageNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem('candoc-theme') ?? 'system');
  const [processExpanded, setProcessExpanded] = useState(false);
  const [enlargedPage, setEnlargedPage] = useState<number | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkPages, setBulkPages] = useState<number[]>([]);
  const [bulkDraft, setBulkDraft] = useState<Draft>({ status: 'excluded', reason: '', note: '', evidence: 'page_image' });
  const [thumbnailSize, setThumbnailSize] = useState(240);
  const [showText, setShowText] = useState(false);
  const [suggestions, setSuggestions] = useState<PageSuggestion[]>([]);
  const [roleDirty, setRoleDirty] = useState(false), [roleValid, setRoleValid] = useState(false);
  const roleRef = useRef<RoleReviewHandle>(null);
  const [sidePanel, setSidePanel] = useState<'none' | 'ai' | 'detail'>('none');
  const [aiPanelHost, setAiPanelHost] = useState<HTMLDivElement | null>(null);
  const [elements, setElements] = useState<ElementInfo[] | null>(null);
  const [unsavedPrompt, setUnsavedPrompt] = useState(false);
  const pendingAction = useRef<(() => Promise<void>) | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const imageCloseRef = useRef<HTMLButtonElement>(null);
  const bulkReasonRef = useRef<HTMLTextAreaElement>(null);
  const selectionQueue = useRef<Promise<void>>(Promise.resolve());
  const lastFocused = useRef<HTMLElement | null>(null);

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    window.document.documentElement.dataset.theme = theme;
    if (theme === 'system') localStorage.removeItem('candoc-theme');
    else localStorage.setItem('candoc-theme', theme);
  }, [theme]);
  async function load() {
    try {
      const [doc, state] = await Promise.all([request<DocumentInfo>('/api/document'), request<Review>('/api/review')]);
      setDocument(doc); receive(state); setError(''); setQuery('');
      projectAgent.setOpen(localStorage.getItem(`candoc-project-agent:${doc.sourceHash}`) === 'open');
      const preference = localStorage.getItem(`candoc-side-panel:${doc.sourceHash}`);
      setSidePanel(preference === 'ai' ? 'ai' : preference === 'none' ? 'none' : state.panelVisible ? 'detail' : 'none');
    } catch (e) { setError((e as Error).message); }
  }
  function receive(state: Review) { reviewRef.current = state; setReview(state); }
  function choosePanel(panel: 'none' | 'ai' | 'detail') {
    if (panel !== 'none') projectAgent.setOpen(false);
    setSidePanel(panel);
    if (document) localStorage.setItem(`candoc-side-panel:${document.sourceHash}`, panel);
  }
  useEffect(() => { if (projectAgent.open) setSidePanel('none'); }, [projectAgent.open]);
  function toggleDetailPanel() {
    const opening = sidePanel !== 'detail';
    guard(async () => {
      await navigate({ panelVisible: opening });
      if (reviewRef.current!.panelVisible === opening) choosePanel(opening ? 'detail' : 'none');
    });
  }
  const page = document?.pages.find(page => page.number === review?.selectedPage);
  const decision = review?.decisions.find(decision => decision.page === review.selectedPage);
  const documentInfo = review?.activeStage === 0;
  const stage = documentInfo ? { id: 0, name: '문서 정보', status: 'pending' as const, note: '' } : review?.stages.find(stage => stage.id === review.activeStage);
  useEffect(() => { if (decision && page) setDraft(draftOf(decision, page)); }, [decision?.page, decision?.status, decision?.reason, decision?.note, decision?.evidence, page?.number]);
  useEffect(() => { setStageNote(stage?.note ?? ''); }, [stage?.id, stage?.note]);
  useEffect(() => { if (review) setThumbnailSize(review.thumbnailSize); }, [review?.thumbnailSize]);
  const pageDirty = !!(draft && decision && page && !same(draft, draftOf(decision, page)));
  const stageDirty = stageNote !== (stage?.note ?? '');
  const dirty = pageDirty || stageDirty || roleDirty;
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (dirty || (bulkOpen && (bulkDraft.reason || bulkDraft.note))) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, bulkOpen, bulkDraft.reason, bulkDraft.note]);
  useEffect(() => {
    if (!page || !showText) { setElements(null); return; }
    let active = true;
    setElements(null);
    request<{ elements: ElementInfo[] }>(`/api/pages/${page.number}`).then(data => { if (active) setElements(data.elements); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [page?.number, showText]);
  useEffect(() => {
    if (!unsavedPrompt && !enlargedPage && !bulkOpen) return;
    lastFocused.current = window.document.activeElement as HTMLElement;
    if (bulkOpen) bulkReasonRef.current?.focus();
    else (unsavedPrompt ? cancelRef : imageCloseRef).current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setUnsavedPrompt(false); setEnlargedPage(null); setBulkOpen(false); pendingAction.current = null; }
      if (event.key === 'Tab') {
        const modal = window.document.querySelector<HTMLElement>('[role="dialog"]');
        const focusable = modal?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, a[href]');
        if (!focusable?.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); lastFocused.current?.focus(); };
  }, [unsavedPrompt, enlargedPage, bulkOpen]);
  async function mutate(url: string, payload: object): Promise<boolean> {
    setBusy(true); setError('');
    try {
      const state = await request<Review>(url, { ...payload, revision: reviewRef.current!.revision });
      receive(state); return true;
    } catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  async function saveDecision() {
    if (!draft || !page) return false;
    const saved = await mutate(`/api/review/pages/${page.number}`, draft);
    if (saved) setNotice(`원본 ${page.number}페이지의 ${labels[draft.status]} 판단을 저장했습니다.`);
    return saved;
  }
  async function saveStage(action: 'save_note' | 'complete' | 'reopen', includeUnreviewed = false) {
    if (!stage) return false;
    const saved = await mutate(`/api/review/stages/${stage.id}`, { action, note: stageNote, includeUnreviewed });
    if (saved) setNotice(action === 'complete' ? '이 단계의 완료를 기록했습니다.' : action === 'reopen' ? '이 단계를 다시 검토할 수 있습니다.' : '검토 메모를 저장했습니다.');
    return saved;
  }
  async function saveDrafts() {
    if (roleDirty && !(await roleRef.current?.save())) return false;
    if (pageDirty && !(await saveDecision())) return false;
    if (stageDirty && !(await saveStage('save_note'))) return false;
    return true;
  }
  function guard(action: () => Promise<void>) {
    if (busy) return;
    if (dirty) { pendingAction.current = action; setUnsavedPrompt(true); }
    else void action();
  }
  async function navigate(values: Partial<{ stage: number; selectedPage: number; selectedPages: number[]; panelVisible: boolean; thumbnailSize: number; filter: string }>) {
    const current = reviewRef.current!;
    const saved = await mutate('/api/review/navigation', { stage: current.activeStage, selectedPage: current.selectedPage, selectedPages: current.selectedPages, panelVisible: current.panelVisible, thumbnailSize: current.thumbnailSize, filter: current.filter, ...values });
    if (saved) { setNotice(''); setShowText(false); }
  }
  function selectPage(number: number, shift: boolean) {
    const run = async () => {
      const queued = selectionQueue.current.then(async () => {
        const current = reviewRef.current!;
        let selectedPages: number[];
        if (shift) {
          const ordered = document!.pages.filter(item => (current.filter === 'all' || current.decisions.find(decision => decision.page === item.number)?.status === current.filter) && (!query || String(item.number).includes(query.trim()))).map(item => item.number);
          const anchor = current.selectedPages.length ? ordered.indexOf(current.selectedPage) : -1, end = ordered.indexOf(number);
          const range = anchor < 0 ? [number] : ordered.slice(Math.min(anchor, end), Math.max(anchor, end) + 1);
          selectedPages = [...new Set([...current.selectedPages, ...range])];
        } else {
          selectedPages = current.selectedPages.includes(number) ? current.selectedPages.filter(page => page !== number) : [...current.selectedPages, number];
        }
        await navigate({ selectedPage: shift && current.selectedPages.length ? current.selectedPage : number, selectedPages });
      });
      selectionQueue.current = queued.catch(() => {});
      await queued;
    };
    if (dirty) { pendingAction.current = run; setUnsavedPrompt(true); }
    else void run();
  }
  function tileClick(event: React.MouseEvent, number: number) {
    if (event.detail > 1) return;
    selectPage(number, event.shiftKey);
  }
  function enlarge(number: number) { pendingAction.current = null; setUnsavedPrompt(false); setEnlargedPage(number); }
  function openBulk(status: DecisionStatus) {
    guard(async () => {
      const pages = reviewRef.current!.selectedPages;
      setBulkPages(pages);
      const suggested = status === 'excluded' && pages.length > 0 && pages.every(number => suggestions.some(item => item.pages.includes(number)));
      const reason = suggested ? [...new Set(suggestions.filter(item => item.pages.some(number => pages.includes(number))).map(item => item.reason))].join(' / ') : '';
      setBulkDraft({ status, reason: reason.length <= 10000 ? reason : '', note: '', evidence: suggested ? 'json' : pages.every(number => document!.pages.find(page => page.number === number)?.imageAvailable) ? 'page_image' : 'json' });
      setBulkOpen(true);
    });
  }
  async function saveBulk() {
    const saved = await mutate('/api/review/pages', { ...bulkDraft, pages: bulkPages });
    if (saved) { setBulkOpen(false); setNotice(`선택한 ${bulkPages.length}페이지의 ${labels[bulkDraft.status]} 판단을 함께 저장했습니다.`); }
  }
  function selectSuggestions(pages: number[]) {
    guard(async () => {
      setQuery('');
      await navigate({ filter: 'all', selectedPage: pages[0], selectedPages: [...new Set([...reviewRef.current!.selectedPages, ...pages])] });
      if (window.matchMedia('(max-width: 970px)').matches) choosePanel('none');
    });
  }
  async function proceedUnsaved(save: boolean) {
    if (save && !(await saveDrafts())) { setUnsavedPrompt(false); pendingAction.current = null; return; }
    if (!save && decision && page) { roleRef.current?.discard(); setDraft(draftOf(decision, page)); setStageNote(stage?.note ?? ''); }
    const action = pendingAction.current;
    pendingAction.current = null; setUnsavedPrompt(false);
    await action?.();
  }

  if (!document || !review || !page || !decision || !draft || !stage) return <div className="loading"><strong>CanDoc</strong><p role={error ? 'alert' : 'status'}>{error || '실제 문서와 검수 기록을 읽고 있습니다…'}</p>{error && <Button onClick={load}>다시 불러오기</Button>}</div>;
  const counts = Object.fromEntries(Object.keys(labels).map(key => [key, review.decisions.filter(decision => decision.status === key).length])) as Record<DecisionStatus, number>;
  const visible = document.pages.filter(page => (review.filter === 'all' || review.decisions.find(decision => decision.page === page.number)?.status === review.filter) && (!query || String(page.number).includes(query.trim())));
  const imagePage = document.pages.find(item => item.number === enlargedPage);
  const done = review.stages.filter(stage => stage.status === 'completed').length;
  const validDraft = draft.status !== 'unreviewed' && (draft.status === 'included' || !!draft.reason.trim()) && !!draft.evidence && (draft.evidence !== 'selection' || draft.status === 'included');
  const pageSelectionReady = counts.unreviewed === 0 && counts.pending === 0;
  const impacts = review.impacts.filter(impact => impact.stage === stage.id);
  const impactedPages = [...new Set(impacts.flatMap(impact => impact.affectedPages))].sort((a, b) => a - b);
  return <div className={`app-shell ${projectAgent.open ? 'project-agent-open' : ''}`}>
    <aside className="sidebar" aria-label="검수 과정" data-expanded={processExpanded}>
      <div className="wordmark"><span className="brand-mark">C</span><span>CanDoc</span><Button size="sm" variant="ghost" className="process-toggle" aria-expanded={processExpanded} aria-controls="review-process" onClick={() => setProcessExpanded(!processExpanded)}>{processExpanded ? '검수 과정 접기' : '검수 과정 보기'}<Icon name="chevron" /></Button></div>
      <div className="document-name"><strong>{document.name}</strong><span>{document.pageCount}페이지 · 문서 검수</span></div>
      <div className="process-content" id="review-process">
      <Button variant="ghost" disabled={busy} className={`document-info-link ${documentInfo ? 'info-current' : ''}`} aria-current={documentInfo ? 'page' : undefined} onClick={() => guard(async () => { await navigate({ stage: 0 }); setProcessExpanded(false); })}><Icon name="document" />문서 정보</Button>
      <div className="process-title"><span>전체 검수 과정</span><Badge variant="outline">{done} / {review.stages.length}</Badge></div>
      <nav className="steps">{review.stages.map(item => <Button key={item.id} data-stage-id={item.id} variant="ghost" disabled={busy} className={`step step-${item.status} ${item.id === stage.id ? 'step-current' : ''}`} aria-current={item.id === stage.id ? 'step' : undefined} onClick={() => guard(async () => { await navigate({ stage: item.id }); setProcessExpanded(false); })}>
        <span className="step-symbol" aria-hidden="true">{item.status === 'completed' ? '✓' : item.status === 'needs_review' ? '↻' : <Icon name={stageIcons[item.id]} />}</span>
        <span className="step-name">{item.name}<span className="sr-only"> · {item.status === 'completed' ? '완료' : item.status === 'needs_review' ? '재검토 필요' : '미완료'}</span></span>{item.id === stage.id && <span className="current-dot" aria-hidden="true" />}
      </Button>)}</nav>
      <div className="legend"><span><i /> 완료</span><span><b>진행 중</b></span><span>대기</span></div>
      </div>
      <div className="sidebar-footer"><Button variant="ghost" className="settings-menu" aria-label="설정" title="프로젝트 설정" onClick={openSettings}><Icon name="settings" /><span className="settings-menu-label">설정</span></Button><div className="theme-switch"><Button size="icon" variant="ghost" aria-label="밝은 테마" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}><Icon name="sun" /></Button><Button size="icon" variant="ghost" aria-label="어두운 테마" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}><Icon name="moon" /></Button></div></div>
    </aside>
    <main className="main">
      <header className="topbar"><span className="location-trail"><span className="location-document">{document.name}</span><span className="breadcrumb">/</span>{stage.name}</span><Button variant="ghost" className="project-agent-open-button" aria-label="프로젝트 Agent 열기" aria-expanded={projectAgent.open} onClick={() => { choosePanel('none'); projectAgent.setOpen(!projectAgent.open); }}><Icon name="chat" /><span>Agent</span></Button><span className={`saved-status ${dirty ? 'save-dirty' : ''}`} role="status" title={new Date(review.updatedAt).toLocaleString('ko-KR')}><i />{busy ? '저장 중…' : dirty ? '저장 전 변경' : '저장됨'}</span></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><Button variant="outline" size="sm" disabled={busy} onClick={() => guard(load)}>최신 기록 불러오기</Button></div>}
      <div className="workspace">
        <div className="page-heading"><div><h1>{stage.id === 2 ? '불필요한 페이지 선별' : stage.name}</h1><p>{documentInfo ? '불러온 문서의 기본 정보입니다. 검수는 페이지 선별부터 진행하세요.' : stage.id === 2 ? '제외할 페이지만 고르세요. 나머지는 선별 완료 시 유지됩니다.' : stageHints[stage.id]}</p></div>{stage.status === 'completed' && <Badge className="done-badge">검토 완료</Badge>}</div>
        {impactedPages.length > 0 && <div className="impact-banner" role="status">페이지 판단 변경으로 재검토가 필요합니다. 관련 원본 페이지: {impactedPages.join(', ')}. 이 범위를 확인하고 근거를 보완한 뒤 완료를 다시 기록하세요.</div>}
        {documentInfo ? <section className="document-overview" aria-label="문서 정보">
          <div className="document-facts">
            <div><span>문서명</span><p>{document.name}</p></div>
            <div><span>원본 파일명</span><p>{document.originalFile ?? '알 수 없음'}</p></div>
            <div><span>문서 형식</span><p>{document.schemaName}</p></div>
            <div><span>문서 스키마 버전</span><p>{document.schemaVersion ?? '알 수 없음'}</p></div>
            <div><span>변환 프로그램 버전</span><p>{document.converterVersion ?? '알 수 없음'}<small>이 JSON에는 변환에 사용한 Docling 프로그램 버전이 기록되어 있지 않습니다.</small></p></div>
            <div><span>페이지</span><p>{document.pageCount}페이지</p></div>
            <div><span>문서 요소</span><p>텍스트 {document.textCount.toLocaleString()} · 표 {document.tableCount} · 그림 {document.pictureCount}</p></div>
            <div><span>원문 이미지</span><p>{document.pageCount - document.input.missingImages.length} / {document.pageCount}페이지 연결</p></div>
          </div>
          {!document.input.versionConfirmed && <div className="impact-banner" role="status">이 앱에서 표시를 확인한 문서 스키마 버전은 {document.input.confirmedSchemaVersion}입니다. 현재 버전 {document.schemaVersion ?? '(기록 없음)'}은 표시가 확인되지 않았으며 일부 기능이 제한될 수 있습니다. 페이지 선별은 계속할 수 있습니다.</div>}
          {document.input.missingImages.length > 0 && <div className="impact-banner" role="status">원문 이미지가 없는 페이지: {document.input.missingImages.join(', ')}. 해당 페이지의 이미지 확대·대조는 사용할 수 없으며 JSON을 근거로 검수할 수 있습니다.</div>}
          <p className="document-info-note">파일을 읽어 문서를 표시할 수 있습니다. 문서 정보는 검수 완료가 필요한 단계가 아닙니다.</p>
          <div className="record-actions"><Button onClick={() => guard(() => navigate({ stage: 2 }))}>페이지 선별로 이동</Button></div>
        </section> : stage.id === 2 ? <>
          <div className="gallery-toolbar">
            <label className="search-field"><Icon name="search" /><Input aria-label="원본 페이지 번호 검색" placeholder="페이지 검색" inputMode="numeric" className="page-search" value={query} onChange={event => setQuery(event.target.value)} /></label>
            <label className="filter-field"><span className="sr-only">페이지 상태 필터</span><select value={review.filter} disabled={busy} onChange={event => { const filter = event.target.value; guard(() => navigate({ filter })); }}><option value="all">전체 페이지</option>{(Object.keys(labels) as DecisionStatus[]).map(key => <option key={key} value={key}>{labels[key]}</option>)}</select></label>
            <PageSuggestions sourceHash={document.sourceHash} ruleHash={document.ruleHash} disabled={busy} open={sidePanel === 'ai'} panelHost={aiPanelHost} onOpen={() => choosePanel('ai')} onClose={() => choosePanel('none')} onResult={setSuggestions} onSelect={selectSuggestions} />
            <div className="counts">{(Object.keys(labels) as DecisionStatus[]).map(key => <span className={`count-${key}`} key={key}>{labels[key]} <b>{counts[key]}</b></span>)}</div>
            <details className="review-guide"><summary aria-label="검수 안내"><Icon name="help" /><span className="guide-label">검수 안내</span></summary><div>{stageHints[2]}<p>클릭하면 해당 페이지의 선택만 켜거나 끕니다. Shift+클릭은 기존 선택에 범위를 추가합니다. 더블클릭하면 원문을 크게 볼 수 있습니다. ‘나머지 유지하고 완료’는 검색·필터와 관계없이 전체 문서의 미검수 페이지를 포함 처리합니다. 보류 페이지는 먼저 확인해야 합니다. 번호는 원본 페이지 번호이며, 단계 이동만으로 검토가 완료되지 않습니다.</p></div></details>
            <Button size="sm" variant="ghost" className="panel-toggle" disabled={busy} aria-label={sidePanel === 'detail' ? '상세 패널 닫기' : '상세 패널 열기'} onClick={toggleDetailPanel}><Icon name="panel" /><span className="panel-label">{sidePanel === 'detail' ? '상세 닫기' : '상세'}</span></Button>
          </div>
          <div className="bulk-toolbar"><div><strong>{review.selectedPages.length}페이지 선택</strong><span>{review.selectedPages.length ? '' : 'Shift + 클릭으로 범위 선택'}</span></div><div className="bulk-buttons"><Button size="sm" variant="ghost" disabled={busy || !visible.length} aria-label="목록 전체 선택" onClick={() => guard(() => navigate({ selectedPages: [...new Set([...review.selectedPages, ...visible.map(page => page.number)])] }))}>전체 선택</Button>{review.selectedPages.length > 0 && <><Button size="sm" variant="ghost" disabled={busy} onClick={() => guard(() => navigate({ selectedPages: [] }))}>선택 취소</Button><Button size="sm" variant="ghost" disabled={busy} aria-label="일괄 포함" onClick={() => openBulk('included')}>포함</Button><Button size="sm" disabled={busy} aria-label="일괄 제외" onClick={() => openBulk('excluded')}>제외</Button></>}</div></div>
          <div className={`selection-layout ${sidePanel === 'none' ? 'panel-hidden' : sidePanel === 'ai' ? 'ai-panel-open' : ''}`}>
            <section className="page-gallery" style={{ '--thumbnail-size': `${thumbnailSize}px` } as React.CSSProperties} aria-label="원본 페이지 목록">{visible.map(item => { const state = review.decisions.find(decision => decision.page === item.number)!; const selected = review.selectedPages.includes(item.number); return <div key={item.number} className={`page-tile tile-${state.status} ${selected ? 'tile-selected' : ''}`}><button type="button" aria-label={`원본 ${item.number}페이지 · ${labels[state.status]}`} aria-pressed={selected} className="tile-main" onClick={event => tileClick(event, item.number)} onDoubleClick={() => enlarge(item.number)}>
              <span className="page-sheet">{item.imageAvailable ? <img src={item.imageUrl} alt="" loading="lazy" /> : <span className="missing-image">원문 이미지 없음</span>}{state.status === 'excluded' && <span className="exclusion-overlay" aria-hidden="true"><span className="exclusion-stamp">제외됨</span></span>}</span><div className="tile-caption"><strong>{item.number}</strong>{state.status !== 'unreviewed' && <span>{labels[state.status]}</span>}</div>
            </button>{suggestions.some(suggestion => suggestion.pages.includes(item.number)) && <span className="ai-page-hint" title={suggestions.find(suggestion => suggestion.pages.includes(item.number))!.reason}>AI 추천 · {suggestions.find(suggestion => suggestion.pages.includes(item.number))!.reason}</span>}<label className="tile-checkbox"><input type="checkbox" aria-label={`원본 ${item.number}페이지 선택`} checked={selected} disabled={busy} onChange={() => selectPage(item.number, false)} /></label></div>; })}{!visible.length && <div className="empty">이 조건에 해당하는 페이지가 없습니다.</div>}</section>
            <div ref={setAiPanelHost} className="ai-panel-slot" hidden={sidePanel !== 'ai'} />
            {sidePanel === 'detail' && <section className="decision-panel" aria-label={`원본 ${page.number}페이지 판단`}>
              <div className="panel-title"><strong>원본 {page.number}페이지</strong><Badge variant="outline">저장: {labels[decision.status]}</Badge></div>
              <button type="button" className="source-preview" disabled={!page.imageAvailable} onClick={() => enlarge(page.number)} aria-label={`원본 ${page.number}페이지 크게 보기`}>{page.imageAvailable ? <img src={page.imageUrl} alt={`원본 ${page.number}페이지 이미지`} /> : <span>원문 이미지 없음</span>}</button>
              <div className="image-tools"><Button variant="ghost" size="sm" disabled={!page.imageAvailable} onClick={() => enlarge(page.number)}>이미지 크게 보기 ↗</Button><Button variant="ghost" size="sm" aria-expanded={showText} onClick={() => setShowText(!showText)}>{showText ? 'JSON 텍스트 닫기' : 'JSON 텍스트 보기'}</Button></div>
              {showText && <div className="json-text">{elements === null ? <p>읽는 중…</p> : elements.filter(item => item.text).map((item, index) => <p key={`${item.ref}-${index}`}><small>{item.ref} · {item.label}</small>{item.text}</p>)}{elements?.every(item => !item.text) && <p>이 페이지에 텍스트 요소가 없습니다.</p>}</div>}
              <fieldset className="decision-choices"><legend>페이지 판단</legend>{(['included', 'excluded', 'pending'] as DecisionStatus[]).map(status => <label key={status} className={draft.status === status ? `choice-active choice-${status}` : ''}><input type="radio" name="decision" value={status} checked={draft.status === status} onChange={() => setDraft({ ...draft, status })} disabled={busy} />{labels[status]}</label>)}</fieldset>
              <label className="field-label" htmlFor="page-reason">{draft.status === 'pending' ? '보류 사유' : '판단 사유'}{draft.status === 'excluded' || draft.status === 'pending' ? ' · 필수' : ' · 선택'}</label><Textarea id="page-reason" placeholder={draft.status === 'excluded' ? '제외 사유와 세부 검수하지 않을 범위' : draft.status === 'pending' ? '미확정 사항과 필요한 추가 확인' : '이 페이지를 포함하는 판단 근거'} value={draft.reason} maxLength={10000} disabled={busy} onChange={event => setDraft({ ...draft, reason: event.target.value })} />
              <label className="field-label" htmlFor="page-evidence">사용한 근거</label><select id="page-evidence" disabled={busy} value={draft.evidence} onChange={event => setDraft({ ...draft, evidence: event.target.value as Evidence })}><option value="page_image" disabled={!page.imageAvailable}>원문 페이지 이미지</option><option value="json">JSON 내부 근거</option><option value="both" disabled={!page.imageAvailable}>페이지 이미지 + JSON</option><option value="selection" disabled={draft.status !== 'included'}>페이지 선별에서 유지 결정</option></select>
              <label className="field-label" htmlFor="page-note">검토 메모 · 선택</label><Textarea id="page-note" placeholder="인접 페이지와의 연결 등 후속 확인 사항" value={draft.note} maxLength={10000} disabled={busy} onChange={event => setDraft({ ...draft, note: event.target.value })} />
              {decision.status === 'excluded' && <p className="restore-hint">제외를 취소하려면 ‘포함’을 선택하고 판단을 저장하세요.</p>}
              <div className="decision-actions"><Button variant="outline" disabled={busy || !pageDirty} onClick={() => { setDraft(draftOf(decision, page)); setNotice('페이지 판단의 초안을 취소했습니다.'); }}>초안 취소</Button><Button disabled={busy || !pageDirty || !validDraft} onClick={saveDecision}>판단 저장</Button></div>
              <p className="panel-footnote">제외는 검수 범위 표시입니다. 원본 JSON과 PNG는 보존됩니다.</p>
            </section>}
          </div>
          <div className="display-bar">
            <div className="display-zoom"><label htmlFor="thumbnail-size">크기</label><span aria-hidden="true">−</span><input id="thumbnail-size" aria-label="페이지 썸네일 크기" type="range" min="120" max="360" step="10" disabled={busy} value={thumbnailSize} onChange={event => setThumbnailSize(Number(event.target.value))} onPointerUp={() => guard(() => navigate({ thumbnailSize }))} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) guard(() => navigate({ thumbnailSize })); }} /><span aria-hidden="true">＋</span><strong>{thumbnailSize}px</strong></div>
            <span className="scroll-summary">{visible.length} / {document.pageCount}페이지</span>
            <Button className="selection-complete" size="sm" variant={stage.status === 'completed' || review.selectedPages.length > 0 ? 'outline' : 'default'} disabled={busy || dirty || (stage.status !== 'completed' && counts.pending > 0)} title={counts.pending ? `보류 ${counts.pending}페이지를 먼저 확인하세요.` : `제외 ${counts.excluded}페이지 외의 나머지 ${document.pageCount - counts.excluded}페이지를 포함합니다.`} onClick={() => saveStage(stage.status === 'completed' ? 'reopen' : 'complete', stage.status !== 'completed')}>{stage.status === 'completed' ? '완료 취소' : counts.unreviewed ? '나머지 유지하고 완료' : '페이지 선별 완료 기록'}</Button>
          </div>
          <div className="stage-completion"><div><strong>{counts.pending ? `보류 ${counts.pending}페이지를 먼저 확인하세요.` : pageSelectionReady ? '모든 페이지의 포함·제외 판단이 기록되었습니다.' : `제외 ${counts.excluded}페이지 · 나머지 ${document.pageCount - counts.excluded}페이지 유지`}</strong><p>{counts.pending ? '보류 페이지의 포함·제외를 결정하면 선별을 완료할 수 있습니다.' : '하단 완료 버튼으로 남은 페이지를 유지하고 페이지 선별을 마칩니다. 이후 구조·내용 검수는 계속 진행합니다.'}</p></div></div>
        </> : stage.id === 3 ? <RoleReview ref={roleRef} document={document} review={review} busy={busy} onDirty={(dirty, valid) => { setRoleDirty(dirty); setRoleValid(valid); }} onNavigate={guard} onMutate={mutate} onEnlarge={enlarge} stageNote={stageNote} onNote={setStageNote} stageDirty={stageDirty} onStage={saveStage} /> : stage.id === 4 ? <ReadingReview ref={roleRef} document={document} review={review} busy={busy} onDirty={(dirty, valid) => { setRoleDirty(dirty); setRoleValid(valid); }} onNavigate={guard} onMutate={mutate} onEnlarge={enlarge} stageNote={stageNote} onNote={setStageNote} stageDirty={stageDirty} onStage={saveStage} /> : stage.id === 5 ? <HeadingReview ref={roleRef} document={document} review={review} busy={busy} onDirty={(dirty, valid) => { setRoleDirty(dirty); setRoleValid(valid); }} onNavigate={guard} onMutate={mutate} onEnlarge={enlarge} stageNote={stageNote} onNote={setStageNote} stageDirty={stageDirty} onStage={saveStage} /> : <>
          <section className="stage-record"><Badge variant="outline">수동 검토 기록</Badge><h2>검토한 범위와 근거를 남기세요.</h2><p>이 단계의 전용 검사·편집 화면은 후속 구현 대상입니다. 별도로 검토한 내용을 저장하고, 확인이 끝난 경우에만 완료를 기록하세요.</p><label className="field-label" htmlFor="stage-note">검토 메모 · 완료 기록 시 필수</label><Textarea id="stage-note" value={stageNote} maxLength={10000} disabled={busy} onChange={event => setStageNote(event.target.value)} placeholder="검사 범위, 사용한 근거, 판단, 미확인 사항과 후속 검토" className="stage-note" /><div className="record-actions"><Button variant="outline" disabled={busy || !stageDirty} onClick={() => setStageNote(stage.note)}>초안 취소</Button><Button variant="outline" disabled={busy || !stageDirty} onClick={() => saveStage('save_note')}>메모 저장</Button><Button disabled={busy || !stageNote.trim() || (stage.id === 12 && (!pageSelectionReady || review.stages.some(item => item.id < 12 && item.status !== 'completed')))} onClick={() => saveStage(stage.status === 'completed' ? 'reopen' : 'complete')}>{stage.status === 'completed' ? '완료 취소' : stage.status === 'needs_review' ? '재검토 완료 기록' : '수동 검토 완료 기록'}</Button></div></section>
        </>}
        <div className="notice" role="status">{notice}</div>
      </div>
      <footer className="footer"><span>원본 보존 · 검수 기록 저장</span><span>CanDoc</span></footer>
    </main>
    {imagePage && <div className="modal-backdrop"><div className="image-modal" role="dialog" aria-modal="true" aria-labelledby="image-modal-title"><div className="modal-header"><strong id="image-modal-title">원본 {imagePage.number}페이지</strong><Button variant="outline" ref={imageCloseRef} onClick={() => setEnlargedPage(null)}>닫기</Button></div><div className="large-image">{imagePage.imageAvailable ? <img src={imagePage.imageUrl} alt={`원본 ${imagePage.number}페이지 확대 이미지`} /> : <p>이 페이지의 원문 이미지가 없습니다.</p>}</div></div></div>}
    {bulkOpen && <div className="modal-backdrop"><div className="bulk-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-title"><h2 id="bulk-title">선택한 {bulkPages.length}페이지 {labels[bulkDraft.status]}</h2><p className="bulk-page-numbers">원본 페이지: {bulkPages.slice().sort((a, b) => a - b).join(', ')}</p><label className="field-label" htmlFor="bulk-reason">공통 판단 사유{bulkDraft.status === 'excluded' ? ' · 필수' : ' · 선택'}</label><Textarea id="bulk-reason" ref={bulkReasonRef} maxLength={10000} value={bulkDraft.reason} onChange={event => setBulkDraft({ ...bulkDraft, reason: event.target.value })} placeholder={bulkDraft.status === 'excluded' ? '제외 사유와 세부 검수하지 않을 범위' : '포함하거나 제외를 취소하는 판단 근거'} /><label className="field-label" htmlFor="bulk-evidence">사용한 근거</label><select id="bulk-evidence" value={bulkDraft.evidence} onChange={event => setBulkDraft({ ...bulkDraft, evidence: event.target.value as Evidence })}><option value="page_image" disabled={bulkPages.some(number => !document.pages.find(page => page.number === number)?.imageAvailable)}>원문 페이지 이미지</option><option value="json">JSON 내부 근거</option><option value="both" disabled={bulkPages.some(number => !document.pages.find(page => page.number === number)?.imageAvailable)}>페이지 이미지 + JSON</option></select><label className="field-label" htmlFor="bulk-note">공통 검토 메모 · 선택</label><Textarea id="bulk-note" maxLength={10000} value={bulkDraft.note} onChange={event => setBulkDraft({ ...bulkDraft, note: event.target.value })} placeholder="인접 페이지와 연결되는 내용 등 후속 확인 사항" /><p className="panel-footnote">각 페이지에 같은 사유·근거를 기록하며 원본은 보존합니다.</p><div className="prompt-actions"><Button variant="outline" disabled={busy} onClick={() => setBulkOpen(false)}>취소</Button><Button disabled={busy || (bulkDraft.status === 'excluded' && !bulkDraft.reason.trim())} onClick={saveBulk}>{bulkPages.length}페이지 {labels[bulkDraft.status]} 저장</Button></div></div></div>}
    {unsavedPrompt && <div className="modal-backdrop"><div className="unsaved-modal" role="dialog" aria-modal="true" aria-labelledby="unsaved-title"><h2 id="unsaved-title">저장하지 않은 변경이 있습니다.</h2><p>현재 초안을 저장하거나 취소한 뒤 이동할 수 있습니다.</p><div className="prompt-actions"><Button variant="outline" ref={cancelRef} disabled={busy} onClick={() => { pendingAction.current = null; setUnsavedPrompt(false); }}>현재 화면 유지</Button><Button variant="outline" disabled={busy} onClick={() => proceedUnsaved(false)}>초안 취소 후 이동</Button><Button disabled={busy || (pageDirty && !validDraft) || (roleDirty && !roleValid)} onClick={() => proceedUnsaved(true)}>저장 후 이동</Button></div></div></div>}
    <ProjectAgentPanel document={document} review={review} dirty={dirty} busy={busy} onMutate={mutate} onNavigate={guard} onPage={number => navigate({ selectedPage: number })} />
  </div>;
}

createRoot(window.document.getElementById('root')!).render(<ProjectCodexProvider><ProjectAgentProvider><App /></ProjectAgentProvider></ProjectCodexProvider>);
