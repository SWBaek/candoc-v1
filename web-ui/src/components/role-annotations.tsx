import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type PointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { AnnotationRect, RoleAnnotationContext, RoleAnnotationGroup, RoleElement } from '@/types';
import type { RoleReviewProps, RoleReviewHandle } from './role-review';

import { ProjectCodexLink, useProjectCodex } from './project-codex-settings';
const names: Record<string, string> = { header: '머리말', footer: '꼬리말', page_number: '페이지 번호', body: '본문', title: '제목', unknown: '미확정' };
const styleBox = (rect: AnnotationRect) => ({ left: `${rect.left * 100}%`, top: `${rect.top * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` });
function overlaps(a: AnnotationRect, b: AnnotationRect) { return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height; }
export const RoleAnnotations = forwardRef<RoleReviewHandle, RoleReviewProps & { items: RoleElement[]; initialPage: number }>(function RoleAnnotations(props, ref) {
  const { document: doc, review, busy, onDirty, onNavigate, onMutate, items, initialPage } = props;
  const retained = doc.pages.filter(page => review.decisions.find(row => row.page === page.number)?.status !== 'excluded');
  const [pageNo, setPageNo] = useState(initialPage || retained[0]?.number || 0), [rect, setRect] = useState<AnnotationRect | null>(null), [comment, setComment] = useState(''), [drawing, setDrawing] = useState(false);
  const [context, setContext] = useState<RoleAnnotationContext | null>(null), [annotationId, setAnnotationId] = useState(''), [panel, setPanel] = useState(false), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const { state: { settings: { model, effort } } } = useProjectCodex();
  const [exceptions, setExceptions] = useState<Record<string, string[]>>({}), [activeRef, setActiveRef] = useState('');
  const imageRef = useRef<HTMLImageElement>(null), canvasRef = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLTextAreaElement>(null), panelRef = useRef<HTMLElement>(null), openerRef = useRef<HTMLButtonElement>(null), sequence = useRef(0), mounted = useRef(true);
  const [narrow, setNarrow] = useState(window.matchMedia('(max-width: 970px)').matches);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null), latestRect = useRef<AnnotationRect | null>(null);
  const annotation = context?.annotations.find(row => row.id === annotationId), job = context?.jobs.find(row => row.annotationId === annotationId), running = context?.jobs.some(row => row.status === 'running');
  const dirty = !!rect || !!comment;
  const page = doc.pages.find(page => page.number === pageNo), active = items.find(item => item.ref === activeRef);
  const matches = rect ? items.filter(item => item.ref.startsWith('#/texts/') && item.provenance.some(prov => prov.page === pageNo && prov.rect && overlaps(rect, prov.rect))) : [];
  const valid = !!rect && !!comment.trim() && matches.length > 0;
  async function call(url: string, method = 'GET', body?: object) {
    const response = await fetch(url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const value = await response.json(); if (!response.ok) throw Error(value.error); return value;
  }
  async function load() {
    const version = ++sequence.current;
    try {
      const value: RoleAnnotationContext = await call('/api/role-annotations');
      if (!mounted.current) return;
      if (value.sourceHash !== doc.sourceHash || value.ruleHash !== doc.ruleHash) throw Error('주석의 문서 근거가 바뀌었습니다. 새로고침하세요.');
      if (version !== sequence.current) return value;
      setContext(value); setAnnotationId(id => value.annotations.some(row => row.id === id) ? id : value.annotations[0]?.id ?? ''); return value;
    } catch (e) { if (mounted.current) setError((e as Error).message); }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; sequence.current++; }; }, [doc.sourceHash, doc.ruleHash]);
  useEffect(() => { void load(); }, [review.revision]);
  useEffect(() => { if (!running) return; const timer = window.setInterval(() => { void load(); }, 700); return () => clearInterval(timer); }, [running]);
  useEffect(() => { onDirty(dirty, valid); }, [dirty, valid]);
  useEffect(() => () => onDirty(false, false), []);
  useEffect(() => { const media = window.matchMedia('(max-width: 970px)'), update = () => setNarrow(media.matches); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  // Native Tab elsewhere; the narrow response drawer alone contains focus.
  useEffect(() => {
    if (!panel) return;
    const previous = globalThis.document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setPanel(false); event.preventDefault(); return; }
      if (event.key !== 'Tab' || !window.matchMedia('(max-width: 970px)').matches) return;
      const nodes = [...panelRef.current!.querySelectorAll<HTMLElement>('button,select,textarea,input,summary')].filter(node => !node.matches(':disabled') && node.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && globalThis.document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    globalThis.document.addEventListener('keydown', handler);
    return () => { globalThis.document.removeEventListener('keydown', handler); (previous?.isConnected ? previous : openerRef.current)?.focus(); };
  }, [panel]);
  function discard() { drag.current = null; latestRect.current = null; setRect(null); setComment(''); setDrawing(false); setError(''); onDirty(false, false); }
  async function save() {
    if (!valid || !matches.length) return false;
    const ok = await onMutate('/api/review/role-annotations', { sourceHash: doc.sourceHash, ruleHash: doc.ruleHash, page: pageNo, rect, comment });
    if (ok) { discard(); const next = await load(); if (next) { setAnnotationId(next.annotations[0]?.id ?? ''); setPanel(true); } }
    return ok;
  }
  useImperativeHandle(ref, () => ({ save, discard }));
  const navigate = (action: () => void) => onNavigate(async () => action());
  function point(event: PointerEvent) {
    const bounds = imageRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!drawing || busy || pending || event.button !== 0 || (event.target as HTMLElement).closest('button,textarea,input,label')) return;
    event.preventDefault(); const start = point(event); drag.current = { id: event.pointerId, ...start }; event.currentTarget.setPointerCapture(event.pointerId); latestRect.current = null; setRect(null); setActiveRef('');
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current; if (!start || start.id !== event.pointerId) return;
    const end = point(event), next = { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
    latestRect.current = next; setRect(next);
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    pointerMove(event); drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId);
    const next = latestRect.current, bounds = imageRef.current!.getBoundingClientRect();
    if (!next || next.width * bounds.width < 5 || next.height * bounds.height < 5) { setRect(null); setError('조금 더 넓은 영역을 드래그하세요.'); return; }
    setDrawing(false); setError(''); requestAnimationFrame(() => inputRef.current?.focus());
  }
  function keyboardBox(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!drawing || event.target !== event.currentTarget || busy || pending) return;
    if (event.key === 'Escape') { event.preventDefault(); discard(); return; }
    if (event.key === 'Enter' && rect) { event.preventDefault(); setDrawing(false); requestAnimationFrame(() => inputRef.current?.focus()); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const first = items.flatMap(item => item.provenance).find(prov => prov.page === pageNo && prov.rect)?.rect;
    const next = { ...(rect ?? first) }; if (!first && !rect) { setError('조절을 시작할 JSON bbox가 없습니다.'); return; }
    event.preventDefault();
    if (event.shiftKey) {
      next.width = Math.max(.01, Math.min(1 - next.left!, next.width! + (event.key === 'ArrowRight' ? .01 : event.key === 'ArrowLeft' ? -.01 : 0)));
      next.height = Math.max(.01, Math.min(1 - next.top!, next.height! + (event.key === 'ArrowDown' ? .01 : event.key === 'ArrowUp' ? -.01 : 0)));
    } else {
      next.left = Math.max(0, Math.min(1 - next.width!, next.left! + (event.key === 'ArrowRight' ? .01 : event.key === 'ArrowLeft' ? -.01 : 0)));
      next.top = Math.max(0, Math.min(1 - next.height!, next.top! + (event.key === 'ArrowDown' ? .01 : event.key === 'ArrowUp' ? -.01 : 0)));
    }
    setRect(next as AnnotationRect); latestRect.current = next as AnnotationRect;
  }
  async function request() {
    setPending(true); setError('');
    try { await call('/api/review/role-annotation-suggestions', 'POST', { revision: review.revision, sourceHash: doc.sourceHash, ruleHash: doc.ruleHash, annotationId, model, effort }); setExceptions({}); await load(); }
    catch (e) { setError((e as Error).message); } finally { setPending(false); }
  }
  async function apply(group: RoleAnnotationGroup) {
    const ok = await onMutate('/api/review/role-annotation-apply', { id: job!.id, groupId: group.id, exceptions: exceptions[group.id] ?? [], sourceHash: doc.sourceHash, ruleHash: doc.ruleHash });
    if (ok) { setExceptions({}); await load(); }
  }
  function locate(item: RoleElement) {
    navigate(() => { const location = item.provenance.find(prov => prov.rect && retained.some(page => page.number === prov.page)); setPageNo(location?.page ?? item.pages.find(page => retained.some(row => row.number === page)) ?? 0); setActiveRef(item.ref); setDrawing(false); if (window.matchMedia('(max-width: 970px)').matches) setPanel(false); imageRef.current?.scrollIntoView({ block: 'start' }); });
  }
  function openAnnotation(id: string) { navigate(() => { const row = context!.annotations.find(row => row.id === id)!; setAnnotationId(id); setPageNo(row.page); setActiveRef(''); setPanel(true); setDrawing(false); }); }
  return <section className="role-annotation-review" aria-label="원본 영역 주석 검수">
    <div className="role-toolbar"><label>대표 원본<select aria-label="주석 원본 페이지" value={pageNo} disabled={busy || pending} onChange={event => navigate(() => { setPageNo(Number(event.target.value)); setActiveRef(''); setDrawing(false); })}>{retained.map(page => <option key={page.number} value={page.number}>{page.number}페이지{page.imageAvailable ? '' : ' · 이미지 없음'}</option>)}</select></label><Button variant="outline" aria-pressed={drawing} disabled={busy || pending || !page?.imageAvailable} onClick={() => { setDrawing(!drawing); setError(''); if (!drawing) requestAnimationFrame(() => canvasRef.current?.focus({ preventScroll: true })); }}>영역 표시</Button><Button ref={openerRef} variant="ghost" disabled={!annotation} onClick={() => setPanel(!panel)}>주석·AI 응답</Button></div>
    {error && <p role="alert">{error}</p>}
    <p className="role-scope-note">{drawing ? '머리말·꼬리말 전체를 드래그하세요. 키보드: 방향키 이동 · Shift+방향키 크기 · Enter 코멘트.' : '원본에 영역을 표시하고, 그 상자에 원하는 처리를 적어주세요.'}</p>
    <div className={`role-annotation-layout ${panel ? 'role-annotation-panel-open' : ''}`}>
      <div className="role-annotation-main">
        {page?.imageAvailable ? <div ref={canvasRef} tabIndex={drawing ? 0 : -1} aria-label="원본 영역 표시" className={`role-annotation-canvas ${drawing ? 'is-drawing' : ''}`} onKeyDown={keyboardBox} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { if (drag.current) { drag.current = null; latestRect.current = null; setRect(null); } }}>
          <img ref={imageRef} draggable={false} src={page.imageUrl} alt={`주석 원본 ${pageNo}페이지`} />
          {active?.provenance.filter(prov => prov.page === pageNo && prov.rect).map((prov, index) => <div key={index} className="role-bbox" aria-label="추천 대상 원본 위치" style={styleBox(prov.rect!)} />)}
          {context?.annotations.filter(row => row.page === pageNo).map(row => <div key={row.id} className={`role-annotation-box ${row.id === annotationId ? 'is-active' : ''}`} style={styleBox(row.rect)}><Button variant="outline" className="role-annotation-marker" aria-label={`영역 주석 ${row.comment}`} onClick={() => openAnnotation(row.id)}>코멘트</Button></div>)}
          {rect && <><div className="role-annotation-box is-active" aria-label="표시한 주석 영역" style={styleBox(rect)} />{!drag.current && !drawing && <div className={`role-annotation-comment ${rect.top + rect.height > .65 ? 'above-box' : ''}`} style={{ left: `${Math.min(rect.left, .45) * 100}%`, top: `${(rect.top + rect.height > .65 ? rect.top : rect.top + rect.height) * 100}%` }}>
            <label htmlFor="role-area-comment">이 영역에 대한 코멘트</label><Textarea ref={inputRef} id="role-area-comment" value={comment} maxLength={2000} disabled={busy} placeholder="이런 반복 문구를 문서 전체에서 찾아 머리말로 처리해줘." onChange={event => setComment(event.target.value)} />
            <p>{matches.length ? `대응 JSON 텍스트 ${matches.length}개 · 일부 겹친 요소도 포함됩니다.` : '대응 JSON 텍스트 없음 · 누락 원문을 추정하지 않습니다.'}</p><div className="record-actions"><Button variant="ghost" disabled={busy} onClick={discard}>취소</Button><Button disabled={busy || !valid || !matches.length} onClick={() => void save()}>주석 저장</Button></div>
          </div>}</>}
        </div> : <p className="role-no-image">원문 이미지가 없어 영역을 표시할 수 없습니다. 이미지가 있는 유지 페이지를 선택하세요.</p>}
        {active && <details open><summary>활성 원본 · {active.ref}</summary><p>{active.text}</p><p>모든 출처 {active.pages.join(', ')}페이지 · 소속 {active.parentRef || '없음'}</p>{!active.provenance.some(prov => prov.page === pageNo && prov.rect) && <p>대응 bbox 없음 · 이전 강조를 남기지 않습니다.</p>}<pre>{JSON.stringify(active, null, 2)}</pre></details>}
        {review.roleUndo && <Button variant="ghost" disabled={busy || dirty || !review.roleUndo.canRestore} onClick={() => void onMutate('/api/review/role-groups', { action: 'restore', id: review.roleUndo!.id })}>직전 일괄 판단 복원</Button>}
      </div>
      {panel && <><div className="role-annotation-backdrop" onClick={() => setPanel(false)} /><aside ref={panelRef} className="role-annotation-panel" role={narrow ? 'dialog' : 'complementary'} aria-modal={narrow || undefined} aria-label="주석에 연결된 AI 응답">
        <div className="ai-panel-header"><strong>주석·AI 응답</strong><Button variant="ghost" onClick={() => setPanel(false)}>닫기</Button></div>
        <div className="role-annotation-thread">
          {!!context?.annotations.length && <select aria-label="저장된 영역 주석" value={annotationId} disabled={busy || dirty} onChange={event => openAnnotation(event.target.value)}>{context.annotations.map(row => <option key={row.id} value={row.id}>{row.page}페이지 · {row.comment}</option>)}</select>}
          {annotation && <><div className="role-annotation-message"><strong>원본 {annotation.page}페이지에 남긴 요청</strong><p>{annotation.comment}</p><Button variant="ghost" disabled={dirty} onClick={() => openAnnotation(annotation.id)}>표시 영역으로 이동</Button><details><summary>예시 JSON {annotation.matches.length}개</summary>{annotation.matches.map(match => <p key={match.ref}>{items.find(item => item.ref === match.ref)?.text} · {match.ref}{match.locations.some(row => row.overlap < 1 - 1e-9) ? ' · 일부 겹침' : ''}</p>)}</details></div>
            <ProjectCodexLink />
            <p className="role-scope-note">Agent에는 좌표·bbox·JSON 텍스트를 전달합니다. PNG는 사람의 원문 확인용입니다.</p><Button disabled={busy || pending || running || dirty || !model || !effort} onClick={() => void request()}>이 주석으로 Agent에 요청</Button>
          </>}
          {running && <div role="status"><p>유지 페이지의 문구·위치·분할 형태를 비교하고 있습니다…</p><Button variant="outline" onClick={() => { const current = context!.jobs.find(row => row.status === 'running')!; void call('/api/review/role-annotation-suggestions', 'DELETE', { id: current.id }).then(setContext).catch(e => setError(e.message)); }}>추천 생성 취소</Button></div>}
          {job?.error && <p role="alert">{job.error}</p>}{job?.status === 'cancelled' && <p>추천 생성을 취소했습니다. 주석은 보존됩니다.</p>}
          {job && <p className="role-scope-note">요청 모델 {job.model} · Reasoning effort {job.effort}</p>}
          {job?.stale && <p className="role-scope-note">검수 버전이 바뀐 추천입니다. 다시 요청해야 저장할 수 있습니다.</p>}
          {job?.status === 'completed' && !job.suggestions.length && <p>추천 대상이 없습니다. 검수 완료나 오류 없음 판정은 아닙니다.</p>}
          {job?.suggestions.map(group => <section className="role-annotation-response" key={`${job.id}:${group.id}`} aria-label="영역 추천 묶음"><p>{group.reason}</p><p>대상 {group.changes.length}개 · 선택 {group.changes.length - (exceptions[group.id] ?? []).length}개 · 예외 {(exceptions[group.id] ?? []).length}개</p><details><summary>대상·변경 전후·예외 확인</summary>{group.changes.map(change => { const item = items.find(item => item.ref === change.ref)!; return <div key={change.ref} className="role-annotation-target"><label><input type="checkbox" aria-label={`${change.ref} 영역 추천 대상`} checked={!(exceptions[group.id] ?? []).includes(change.ref)} disabled={busy} onChange={event => setExceptions({ ...exceptions, [group.id]: event.target.checked ? (exceptions[group.id] ?? []).filter(ref => ref !== change.ref) : [...(exceptions[group.id] ?? []), change.ref] })} />{item.text}<small>원본 {item.pages.join(', ')}페이지 · {names[change.before.role] || change.before.role} → {names[change.after.role]} · 소속 유지</small></label><Button variant="ghost" onClick={() => locate(item)}>원본 위치</Button></div>; })}</details><p className="role-scope-note">선택한 요소 전체의 검수 역할을 저장합니다. 제외 출처도 보존합니다. 이미지 대조를 자동 기록하지 않습니다.</p><Button disabled={busy || dirty || job.stale || job.revision !== review.revision || group.changes.length === (exceptions[group.id] ?? []).length} onClick={() => void apply(group)}>선택한 {group.changes.length - (exceptions[group.id] ?? []).length}개 판단 저장</Button></section>)}
          <p className="role-scope-note">추천은 변경안입니다. 주석·응답 저장만으로 역할이나 단계 완료를 확정하지 않습니다.</p>
        </div>
      </aside></>}
    </div>
  </section>;
});
