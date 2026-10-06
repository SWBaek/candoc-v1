import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { RoleReview as RoleDetails, type RoleReviewProps, type RoleReviewHandle } from './role-review';
import type { DocumentInfo, RoleElement, RoleQuestionContext } from '@/types';
export type { RoleReviewHandle } from './role-review';
const roles: Record<string, string> = { header: '머리말', footer: '꼬리말', page_number: '페이지 번호', caption: '캡션', body: '본문', title: '제목', footnote: '각주', table: '표', picture: '그림', list: '목록', formula: '수식', other: '기타', unknown: '미확정' };
const labels: Record<string, string> = { page_header: '머리말', page_footer: '꼬리말', text: '본문', paragraph: '본문', section_header: '제목', title: '제목', caption: '캡션', footnote: '각주', list_item: '목록', list: '목록', table: '표', picture: '그림', formula: '수식' };
function Source({ item, document, onEnlarge, context = [], preferredPage, active = false, fullPage = false }: { item: RoleElement; document: DocumentInfo; onEnlarge: (page: number) => void; context?: RoleElement[]; preferredPage?: number; active?: boolean; fullPage?: boolean }) {
  const [pageNo, setPageNo] = useState(preferredPage ?? item.pages[0] ?? 0);
  useEffect(() => setPageNo(preferredPage ?? item.pages[0] ?? 0), [item.ref, preferredPage]);
  const page = document.pages.find(page => page.number === pageNo), locations = item.provenance.filter(prov => prov.page === pageNo && prov.rect);
  const boxes = [item, ...context].flatMap(node => node.provenance.filter(prov => prov.page === pageNo && prov.rect).map(prov => prov.rect!));
  const crop = { left: 0, top: 0, width: 1, height: 1 };
  if (!fullPage && boxes.length && page?.width && page.height) {
    const left = Math.min(...boxes.map(box => box.left)), right = Math.max(...boxes.map(box => box.left + box.width)), top = Math.min(...boxes.map(box => box.top)), bottom = Math.max(...boxes.map(box => box.top + box.height));
    crop.width = Math.min(1, Math.max(.35, right - left + .08)); crop.height = Math.min(1, Math.max(.12, bottom - top + .1));
    crop.left = Math.max(0, Math.min(1 - crop.width, (left + right - crop.width) / 2)); crop.top = Math.max(0, Math.min(1 - crop.height, (top + bottom - crop.height) / 2));
  }
  return <article className={`role-question-source ${active ? 'role-active-source' : ''}`} aria-label={active ? `활성 원본 · ${item.ref}` : `대표 원본 · ${item.ref}`}>
    <div className="role-source-caption"><strong>원본 {pageNo ? `${pageNo}페이지` : '페이지 정보 없음'}</strong>{item.pages.length > 1 && <select aria-label={`${item.ref} 출처 페이지`} value={pageNo} onChange={event => setPageNo(Number(event.target.value))}>{item.pages.map(page => <option key={page} value={page}>{page}페이지</option>)}</select>}{page?.imageAvailable && <Button variant="ghost" onClick={() => onEnlarge(pageNo)}>전체 페이지</Button>}</div>
    <div className="role-image-wrap role-focus-crop" style={{ aspectRatio: `${crop.width * (page?.width || 1)} / ${crop.height * (page?.height || 1)}` }}>{page?.imageAvailable ? <><img className="role-page-image" style={{ width: `${100 / crop.width}%`, left: `${-crop.left / crop.width * 100}%`, top: `${-crop.top / crop.height * 100}%` }} src={page.imageUrl} alt={`대조 원본 ${pageNo}페이지 · ${item.ref}`} />{[item, ...context].flatMap((node, nodeIndex) => node.provenance.filter(prov => prov.page === pageNo && prov.rect).map((prov, index) => <div key={`${node.ref}:${index}`} className={`role-bbox ${nodeIndex ? 'role-context-bbox' : ''}`} aria-label={nodeIndex ? `주변 ${node.label} 위치` : '선택 요소 위치'} style={{ left: `${(prov.rect!.left - crop.left) / crop.width * 100}%`, top: `${(prov.rect!.top - crop.top) / crop.height * 100}%`, width: `${prov.rect!.width / crop.width * 100}%`, height: `${prov.rect!.height / crop.height * 100}%` }} />))}</> : <p className="role-no-image">{pageNo ? '원문 이미지 없음 · JSON으로 대조합니다.' : '출처 페이지 없음 · 위치를 추정하지 않습니다.'}</p>}</div>
    {!locations.length && <p className="role-no-image">표시 가능한 bbox가 없습니다.</p>}<p className="role-question-text">{item.text || item.cells.map(cell => cell.text).join(' ') || item.label}</p>
    <details><summary>원본 정보 · {item.ref}</summary><p>라벨 {item.label || '없음'} · 소속 {item.parentRef || '없음'} · 출처 {item.pages.join(', ') || '없음'}</p><pre>{JSON.stringify(item, null, 2)}</pre></details>
  </article>;
}
export const RoleReview = forwardRef<RoleReviewHandle, RoleReviewProps>(function RoleReview(props, ref) {
  const { document, review, busy, onDirty, onNavigate, onMutate, onEnlarge, stageNote, onNote, stageDirty, onStage } = props;
  const [data, setData] = useState<{ items: RoleElement[]; context: RoleQuestionContext } | null>(null), [error, setError] = useState('');
  const [view, setView] = useState<'questions' | 'pages' | 'direct'>('questions'), [questionId, setQuestionId] = useState(''), [pageNo, setPageNo] = useState(0), [activeRef, setActiveRef] = useState('');
  const [selected, setSelected] = useState<string[]>([]), [baseline, setBaseline] = useState<string[]>([]), [action, setAction] = useState<'' | 'apply' | 'keep' | 'defer'>(''), [reason, setReason] = useState(''), [checked, setChecked] = useState(false), [imageChecked, setImageChecked] = useState(false);
  const [directGroupId, setDirectGroupId] = useState<string | undefined>();
  const direct = useRef<RoleReviewHandle>(null), loadVersion = useRef(0), itemMap = new Map(data?.items.map(item => [item.ref, item])), saved = new Map(review.roleReviews.map(row => [row.ref, row]));
  const question = data?.context.questions.find(question => question.id === questionId), pageScope = data?.context.pageScopes.find(page => page.page === pageNo);
  const refs = view === 'pages' ? pageScope?.refs ?? [] : question?.refs ?? [];
  const eligible = view === 'pages' ? pageScope?.eligibleRefs.filter(ref => !saved.has(ref) || saved.get(ref)?.needsReview) ?? [] : question?.targets.map(target => target.ref) ?? [];
  const dirty = view !== 'direct' && (JSON.stringify(selected) !== JSON.stringify(baseline) || !!action || !!reason || checked || imageChecked);
  const valid = selected.length > 0 && selected.every(ref => eligible.includes(ref)) && (view === 'pages' ? checked && selected.every(ref => eligible.includes(ref)) : !!action && (action === 'apply' || !!reason.trim()));
  async function load() {
    const version = ++loadVersion.current;
    try {
      const responses = await Promise.all([fetch('/api/role-elements'), fetch('/api/role-questions')]), [elements, context] = await Promise.all(responses.map(response => response.json()));
      if (responses.some(response => !response.ok)) throw new Error(elements.error || context.error);
      if (elements.sourceHash !== document.sourceHash || elements.ruleHash !== document.ruleHash || context.sourceHash !== document.sourceHash || context.ruleHash !== document.ruleHash) throw new Error('문서 근거가 바뀌었습니다. 새로고침하세요.');
      if (version !== loadVersion.current) return;
      setData({ items: elements.items, context }); setError('');
      setQuestionId(id => context.questions.some((q: { id: string }) => q.id === id) ? id : (context.questions.find((q: { open: number }) => q.open)?.id ?? context.questions[0]?.id ?? ''));
      setPageNo(page => context.pageScopes.some((scope: { page: number }) => scope.page === page) ? page : context.pageScopes[0]?.page ?? 0);
    } catch (error) { setError((error as Error).message); }
  }
  useEffect(() => { void load(); }, [document.sourceHash, document.ruleHash, review.revision]);
  // A context refresh (including conflicts) must not erase pending responses.
  useEffect(() => {
    if (!data || view === 'direct') return;
    const next = view === 'pages' ? eligible : question?.targets.filter(target => ['open', 'defer'].includes(target.state)).map(target => target.ref) ?? [];
    setSelected(next); setBaseline(next); setActiveRef(next[0] ?? refs[0] ?? ''); setAction(''); setReason(''); setChecked(false); setImageChecked(false);
  }, [questionId, pageNo, view]);
  useEffect(() => { if (view !== 'direct') onDirty(dirty, valid); }, [dirty, valid, view]);
  useEffect(() => () => onDirty(false, false), []);
  function discard() { if (view === 'direct') { direct.current?.discard(); return; } setSelected(baseline); setAction(''); setReason(''); setChecked(false); setImageChecked(false); onDirty(false, false); }
  async function save() {
    if (view === 'direct') return direct.current?.save() ?? false;
    if (!valid) return false;
    const payload = view === 'pages' ? { page: pageNo, refs: selected, checkedAll: checked, evidence: imageChecked ? 'both' : 'json' } : { questionId, fingerprint: question!.fingerprint, sourceHash: document.sourceHash, ruleHash: document.ruleHash, refs: selected, action, reason };
    const ok = await onMutate(view === 'pages' ? '/api/review/role-page-check' : '/api/review/role-questions', payload);
    if (ok) { if (view === 'pages') { setSelected([]); setBaseline([]); } else setBaseline(selected); setAction(''); setReason(''); setChecked(false); setImageChecked(false); onDirty(false, false); await load(); }
    return ok;
  }
  useImperativeHandle(ref, () => ({ save, discard }));
  const navigate = (fn: () => void) => onNavigate(async () => fn()), active = itemMap.get(activeRef), scope = review.roleCoverage, stage = review.stages.find(stage => stage.id === 3)!;
  const excludedPages = new Set(review.decisions.filter(row => row.status === 'excluded').map(row => row.page));
  const preferred = (item: RoleElement) => item.pages.find(page => !excludedPages.has(page)) ?? item.pages[0];
  const representativeRefs = [...new Set([eligible[0], eligible[Math.floor(eligible.length / 2)], eligible[eligible.length - 1]])].filter(Boolean);
  const allImages = selected.length > 0 && selected.every(ref => itemMap.get(ref)?.pages.every(page => document.pages.find(item => item.number === page)?.imageAvailable));
  const deferred = data?.context.questions.some(question => question.targets.some(target => target.state === 'defer'));
  const ready = !scope.unsettledPages.length && !scope.unreviewed && !scope.needsReview && !scope.suspected && !deferred;
  const nearItems = active ? data?.items.filter(item => item.pages.some(page => active.pages.includes(page))) ?? [] : [], nearIndex = nearItems.findIndex(item => item.ref === activeRef);
  if (!data) return <div role={error ? 'alert' : 'status'}>{error || '확인할 질문을 읽고 있습니다…'}{error && <Button onClick={() => void load()}>다시 불러오기</Button>}</div>;
  return <section className="role-review role-questions" aria-label="영역 질문 검수">
    <div className="role-toolbar"><select aria-label="영역 검수 보기" value={view} disabled={busy} onChange={event => navigate(() => { setDirectGroupId(view === 'questions' ? question?.groupId : undefined); setView(event.target.value as typeof view); })}><option value="questions">확인할 질문 · {data.context.questions.filter(q => q.open).length} / {data.context.questions.length}묶음</option><option value="pages">페이지별 훑어보기</option><option value="direct">직접 수정</option></select><span className="role-scope-note">전체 범위 {scope.total}개 · 확인 기록 {scope.reviewed} · 미검수 {scope.unreviewed} · 재검토 {scope.needsReview}</span></div>
    {error && <p role="alert">{error}</p>}
    {view === 'direct' ? <RoleDetails {...props} ref={direct} questionHold={deferred} initialRef={activeRef} initialGroupId={directGroupId} /> : <>
      {view === 'questions' ? question ? <>
        <select aria-label="검수 질문 선택" value={questionId} disabled={busy} onChange={event => navigate(() => setQuestionId(event.target.value))}>{data.context.questions.map(q => <option key={q.id} value={q.id}>{!q.targets.length ? '범위 밖' : q.open ? `남음 ${q.open}개` : '응답됨'} · {q.title}</option>)}</select>
        <div className="role-question-heading"><h2>{question.title}</h2><p className="role-scope-note">{question.reason}</p><p className="role-question-range">전체 {refs.length}개 · 범위 내 {eligible.length}개 · 선택 {selected.length}개 · 예외 {Math.max(0, eligible.length - selected.filter(ref => eligible.includes(ref)).length)}개 · 범위 밖 {refs.length - eligible.length}개</p>
          <details><summary>적용 범위·변경 전후·예외 확인</summary><p>원본 페이지 {question.pages.join(', ')}. 선택한 요소의 모든 출처에 같은 역할을 기록합니다. 적용은 검수 기록이며 원본은 유지됩니다.</p>{refs.map(ref => { const item = itemMap.get(ref)!, target = question.targets.find(target => target.ref === ref), proposal = question.proposed.find(row => row.ref === ref)!; return <div className="role-member" key={ref}><label><input type="checkbox" aria-label={`${ref} 질문 대상`} disabled={busy || !target} checked={selected.includes(ref)} onChange={event => { setSelected(event.target.checked ? [...selected, ref] : selected.filter(value => value !== ref)); setActiveRef(ref); }} /><span>{item.text || item.label}<small>원본 {item.pages.join(', ')}페이지 · {saved.has(ref) ? roles[saved.get(ref)!.role] : labels[item.label] || item.label} → {roles[proposal.role]} · 소속 유지</small></span></label><span>{!target ? '범위 밖' : target.stale ? '재검토' : ({ open: '미응답', defer: '보류', keep: '제안 거절', apply: '반영됨', resolved: '역할 확인됨' })[target.state]}</span>{target?.reason && <small>{target.reason}</small>}<Button variant="ghost" onClick={() => setActiveRef(ref)}>원본</Button></div>; })}</details>
        </div>
        <div className="role-representatives" aria-label="대표 원본 비교">{representativeRefs.map(ref => <Source key={ref} item={itemMap.get(ref)!} active={ref === activeRef} preferredPage={preferred(itemMap.get(ref)!)} document={document} onEnlarge={onEnlarge} context={(question.contextRefs ?? []).map(ref => itemMap.get(ref)!).filter(Boolean)} />)}</div>
        {active && !representativeRefs.includes(active.ref) && <Source item={active} active preferredPage={preferred(active)} document={document} onEnlarge={onEnlarge} />}
        {question.kind === 'classification' && <details><summary>주변 문맥</summary>{nearItems.slice(Math.max(0, nearIndex - 2), nearIndex + 3).map(item => <p key={item.ref}>{item.text || item.label}</p>)}</details>}
        {!question.open && <p className="role-scope-note">이 질문은 응답되었습니다. 전체 범위 확인은 별도로 남아 있을 수 있습니다.{data.context.questions.some(q => q.open) && <Button variant="ghost" onClick={() => navigate(() => setQuestionId(data.context.questions.find(q => q.open)!.id))}>다음 질문</Button>}</p>}
        <div className="role-question-actions"><Button disabled={busy || !selected.length} aria-pressed={action === 'apply'} onClick={() => setAction('apply')}>제안 적용</Button><Button variant="outline" disabled={busy || !selected.length} aria-pressed={action === 'keep'} onClick={() => setAction('keep')}>현재대로 유지</Button><Button variant="ghost" disabled={busy || !selected.length} aria-pressed={action === 'defer'} onClick={() => setAction('defer')}>보류</Button><Button variant="ghost" disabled={busy} onClick={() => navigate(() => { setDirectGroupId(question?.groupId); setView('direct'); })}>직접 수정</Button></div>
        {action && <div className="role-response" aria-label="질문 응답 초안"><p>{action === 'apply' ? `${selected.length}개 역할을 검수안에 반영합니다. 근거는 JSON 문구·위치·출현이며 이미지 확인을 자동 기록하지 않습니다.` : action === 'keep' ? '제안을 거절합니다. 기존 분류의 정상 확인이나 전체 검수 완료로 처리하지 않습니다.' : '판단을 보류합니다. 이유와 다음에 확인할 사항을 함께 적어주세요.'}</p>{action !== 'apply' && <><label htmlFor="role-response-reason">{action === 'keep' ? '유지 이유' : '보류 이유·후속 확인'}</label><Textarea id="role-response-reason" value={reason} maxLength={10000} disabled={busy} onChange={event => setReason(event.target.value)} /></>}<div className="record-actions"><Button variant="outline" disabled={busy} onClick={discard}>응답 취소</Button><Button disabled={busy || !valid} onClick={() => void save()}>{selected.length}개 응답 저장</Button></div></div>}
      </> : <p className="role-scope-note">현재 규칙으로 발견한 질문이 없습니다. 검수 완료를 뜻하지 않습니다. 페이지별 훑어보기에서 전체 범위를 확인하세요.</p> : <>
        <label className="role-group-picker">훑어볼 원본 페이지<select aria-label="훑어볼 원본 페이지" value={pageNo} disabled={busy} onChange={event => navigate(() => setPageNo(Number(event.target.value)))}>{data.context.pageScopes.map(scope => <option key={scope.page} value={scope.page}>{scope.page}페이지 · {scope.refs.length}개 요소</option>)}</select></label>
        <p className="role-scope-note">페이지 전체를 훑어 역할과 소속을 확인하세요. 질문 미해결·미확정·여러 유지 페이지 출처 항목은 직접 검토합니다. 출처 없는 요소 {data.context.unlocatedRefs.length}개도 직접 수정에서 확인해야 합니다.</p>
        <div className="role-page-overview">{active && <Source item={active} active fullPage preferredPage={pageNo} document={document} onEnlarge={onEnlarge} />}<div className="role-page-elements" aria-label="페이지 요소 목록">{refs.map(ref => { const item = itemMap.get(ref)!, record = saved.get(ref); return <div className="role-member" key={ref}><input type="checkbox" aria-label={`${ref} 페이지 확인 대상`} disabled={busy || !eligible.includes(ref)} checked={selected.includes(ref)} onChange={event => { setSelected(event.target.checked ? [...selected, ref] : selected.filter(value => value !== ref)); setActiveRef(ref); }} /><Button variant="ghost" className="role-page-row" aria-pressed={activeRef === ref} onClick={() => setActiveRef(ref)}><span>{item.text || item.cells[0]?.text || item.label}<small>{record ? roles[record.role] : labels[item.label] || '미확정'} · 소속 {record?.parentRef || item.parentRef || '없음'} · {record ? record.needsReview ? '재검토' : '기존 기록 유지' : eligible.includes(ref) ? '미검수' : '별도 확인 필요'}</small></span></Button></div>; })}</div></div>
        <Button variant="ghost" disabled={busy || !active} onClick={() => navigate(() => { setDirectGroupId(undefined); setView('direct'); })}>선택 항목 직접 수정</Button><p>새로 확인할 대상 {selected.length}개 · 예외 {Math.max(0, eligible.length - selected.filter(ref => eligible.includes(ref)).length)}개. 기존 기록은 덮어쓰지 않습니다.</p><label className="role-check"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />선택한 요소의 영역·역할·원본 소속을 함께 확인했습니다.</label><label className="role-check"><input type="checkbox" checked={imageChecked} disabled={!allImages} onChange={event => setImageChecked(event.target.checked)} />원문 이미지도 대조했습니다.</label><div className="record-actions"><Button variant="outline" disabled={busy || !dirty} onClick={discard}>확인 초안 취소</Button><Button disabled={busy || !valid} onClick={() => void save()}>{selected.length}개 확인 저장</Button></div>
      </>}
      <details className="role-question-tools"><summary>복원·검수 범위·완료</summary><p>질문 응답과 전체 요소 확인은 별개입니다. 미검수 {scope.unreviewed} · 재검토 {scope.needsReview} · 의심 {scope.suspected} · 페이지 미확정 {scope.unsettledPages.length}. 질문을 모두 처리해도 자동 완료하지 않습니다.</p>{review.roleUndo && <Button variant="outline" disabled={busy || !review.roleUndo.canRestore} onClick={() => navigate(() => { void onMutate('/api/review/role-groups', { action: 'restore', id: review.roleUndo!.id }); })}>직전 일괄 판단 복원</Button>}<label className="field-label" htmlFor="stage-note">전체 검토 범위·근거·미확인 사항</label><Textarea id="stage-note" value={stageNote} disabled={busy} maxLength={10000} onChange={event => onNote(event.target.value)} /><div className="record-actions"><Button variant="outline" disabled={busy || !stageDirty} onClick={() => onNote(stage.note)}>메모 초안 취소</Button><Button variant="outline" disabled={busy || !stageDirty || dirty} onClick={() => void onStage('save_note')}>메모 저장</Button><Button disabled={busy || dirty || !stageNote.trim() || (stage.status !== 'completed' && !ready)} onClick={() => void onStage(stage.status === 'completed' ? 'reopen' : 'complete')}>{stage.status === 'completed' ? '완료 취소' : '영역 검수 완료 기록'}</Button></div></details>
    </>}
  </section>;
});
