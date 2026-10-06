import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { CoarseRole, DocumentInfo, RepeatGroup, Review, RoleDraft, RoleElement, RoleRegion, RoleTarget } from '@/types';

const regionNames: Record<RoleRegion, string> = { header: '머리말 영역', footer: '꼬리말 영역', body: '본문 영역', footnote: '각주 영역', table: '표 내부', picture: '그림 내부', unknown: '미확정' };
const roleNames: Record<CoarseRole, string> = { header: '반복 머리말', footer: '반복 꼬리말', page_number: '페이지 번호', body: '본문', title: '실제 문서·절 제목', footnote: '각주', caption: '캡션', list: '목록', table: '표', picture: '그림', formula: '수식', other: '기타', unknown: '미확정' };
const statusNames = { normal: '정상', error: '오류 확인', suspected: '의심', unjudgeable: '판단 불가' };
const empty = (): RoleDraft => ({ status: '', region: 'unknown', role: 'unknown', parentRef: '', reason: '', evidence: 'json', followUp: '' });
export type RoleReviewHandle = { save: () => Promise<boolean>; discard: () => void };
type Props = { document: DocumentInfo; review: Review; busy: boolean; onDirty: (dirty: boolean, valid: boolean) => void; onNavigate: (action: () => Promise<void>) => void; onMutate: (url: string, payload: object) => Promise<boolean>; onEnlarge: (page: number) => void; stageNote: string; onNote: (value: string) => void; stageDirty: boolean; onStage: (action: 'save_note' | 'complete' | 'reopen') => Promise<boolean> };

export const RoleReview = forwardRef<RoleReviewHandle, Props>(function RoleReview({ document, review, busy, onDirty, onNavigate, onMutate, onEnlarge, stageNote, onNote, stageDirty, onStage }, ref) {
  const [data, setData] = useState<{ items: RoleElement[]; targets: RoleTarget[]; groups: RepeatGroup[] } | null>(null), [error, setError] = useState('');
  const [mode, setMode] = useState<'groups' | 'individual'>('groups');
  const [groupId, setGroupId] = useState(''), [elementRef, setElementRef] = useState(''), [pageNo, setPageNo] = useState(0);
  const [selected, setSelected] = useState<string[]>([]), [draft, setDraft] = useState<RoleDraft>(empty), [baseline, setBaseline] = useState('');
  const excluded = new Set(review.decisions.filter(row => row.status === 'excluded').map(row => row.page));
  const inScope = (item: RoleElement) => !item.pages.length || item.pages.some(page => !excluded.has(page));
  const itemMap = new Map(data?.items.map(item => [item.ref, item]));
  const saved = new Map(review.roleReviews.map(row => [row.ref, row]));
  const group = data?.groups.find(group => group.id === groupId);
  const element = itemMap.get(elementRef);
  const imagePage = document.pages.find(page => page.number === pageNo);
  const members = group?.refs.map(ref => itemMap.get(ref)!).filter(Boolean) ?? [];
  const activeMembers = members.filter(inScope);
  const dirty = !!baseline && baseline !== JSON.stringify([draft, selected]);
  const availableImage = mode === 'groups' ? selected.length > 0 && selected.every(ref => itemMap.get(ref)!.pages.filter(page => !excluded.has(page)).length > 0 && itemMap.get(ref)!.pages.filter(page => !excluded.has(page)).every(page => document.pages.find(item => item.number === page)?.imageAvailable)) : !!element?.pages.length && element.pages.filter(page => !excluded.has(page)).every(page => document.pages.find(item => item.number === page)?.imageAvailable);
  const valid = !!draft.status && !!draft.reason.trim() && (draft.status !== 'normal' || (draft.region !== 'unknown' && draft.role !== 'unknown')) && (!['suspected', 'unjudgeable'].includes(draft.status) || !!draft.followUp.trim()) && (draft.evidence === 'json' || availableImage) && (mode === 'groups' ? selected.length > 0 : !!element && inScope(element));
  function reset(next: RoleDraft, refs: string[]) { setDraft(next); setSelected(refs); setBaseline(JSON.stringify([next, refs])); onDirty(false, false); }
  function openGroup(group: RepeatGroup, items: RoleElement[] = data!.items) {
    const members = group.refs.map(ref => items.find(item => item.ref === ref)!).filter(Boolean), active = members.filter(inScope);
    setMode('groups'); setGroupId(group.id); reset(empty(), active.map(item => item.ref));
    const example = active[0] ?? members[0]; setElementRef(example?.ref ?? ''); setPageNo(example?.pages.find(page => !excluded.has(page)) ?? example?.pages[0] ?? 0);
  }
  function openElement(item: RoleElement, preferredPage?: number) {
    const record = saved.get(item.ref);
    setMode('individual'); setElementRef(item.ref); setPageNo(preferredPage ?? item.pages.find(page => !excluded.has(page)) ?? item.pages[0] ?? 0);
    reset(record ? { status: record.status, region: record.region, role: record.role, parentRef: record.parentRef, reason: record.reason, evidence: record.evidence, followUp: record.followUp } : empty(), []);
  }
  async function load() {
    try {
      setError(''); const response = await fetch('/api/role-elements'), value = await response.json();
      if (!response.ok) throw new Error(value.error);
      if (value.sourceHash !== document.sourceHash || value.ruleHash !== document.ruleHash) throw new Error('검수 대상 문서가 바뀌었습니다. 새로고침하세요.');
      setData(value);
      if (value.groups.length) openGroup(value.groups[0], value.items);
      else { setMode('individual'); const item = value.items.find(inScope); if (item) openElement(item); }
    } catch (error) { setError((error as Error).message); }
  }
  useEffect(() => { void load(); }, [document.sourceHash, document.ruleHash]);
  useEffect(() => { onDirty(dirty, valid); }, [dirty, valid]);
  useEffect(() => () => onDirty(false, false), []);
  function discard() {
    if (baseline) { const [before, refs] = JSON.parse(baseline); setDraft(before); setSelected(refs); onDirty(false, false); }
  }
  async function save() {
    if (!valid) return false;
    const ok = await onMutate(mode === 'groups' ? '/api/review/role-groups' : '/api/review/roles', mode === 'groups' ? { action: 'save', groupId, refs: selected, ...draft } : { ref: elementRef, ...draft });
    if (ok) { setBaseline(JSON.stringify([draft, selected])); onDirty(false, valid); }
    return ok;
  }
  useImperativeHandle(ref, () => ({ save, discard }));
  const change = (action: () => void) => onNavigate(async () => action());
  const changeDraft = (value: Partial<RoleDraft>) => setDraft({ ...draft, ...value });
  const pageItems = data?.items.filter(item => inScope(item) && (pageNo === 0 ? !item.pages.length : item.pages.includes(pageNo))) ?? [];
  const c = review.roleCoverage, stage = review.stages.find(stage => stage.id === 3)!;
  const ready = !c.unsettledPages.length && !c.unreviewed && !c.needsReview && !c.suspected;
  if (!data) return <div role={error ? 'alert' : 'status'}>{error || '영역 검수 대상을 읽고 있습니다…'}{error && <Button variant="outline" onClick={() => void load()}>다시 불러오기</Button>}</div>;
  return <section className="role-review" aria-label="영역·큰 역할·소속 검수">
    <div className="role-toolbar"><Button size="sm" variant={mode === 'groups' ? 'default' : 'outline'} onClick={() => change(() => data.groups.length && openGroup(group ?? data.groups[0]))}>반복 요소 묶음</Button><Button size="sm" variant={mode === 'individual' ? 'default' : 'outline'} onClick={() => change(() => { const item = element && inScope(element) ? element : data.items.find(inScope); if (item) openElement(item); })}>개별 요소 검토</Button><span>검사 대상 {c.total}개 · 기록 {c.reviewed} · 미검수 {c.unreviewed} · 재검토 {c.needsReview} · 의심 {c.suspected}</span></div>
    {c.unsettledPages.length > 0 && <p className="role-scope-note">미검수·보류 페이지도 확인할 수 있습니다. 단계 완료 전에는 페이지 선별을 확정하세요.</p>}
    <p className="role-scope-note">반복 문구·위치·페이지 출현으로 묶은 후보입니다. 실제 제목과 내용이 있는 각주를 구별해 판단하세요. 저장은 검수 기록이며 원본의 라벨·소속·출처를 바꾸지 않습니다.</p>
    {mode === 'groups' ? <label className="role-group-picker">반복 후보 선택<select aria-label="반복 후보 선택" value={groupId} disabled={busy} onChange={event => change(() => openGroup(data.groups.find(group => group.id === event.target.value)!))}>{data.groups.map(group => <option key={group.id} value={group.id}>{roleNames[group.kind]} 후보 · {group.refs.length}개 · {group.normalizedText === '[page-number]' ? '서로 다른 번호' : group.normalizedText.slice(0, 60)}</option>)}</select></label> : <div className="role-toolbar"><label>원본 페이지<select aria-label="영역 검수 원본 페이지" value={pageNo} disabled={busy} onChange={event => { const number = Number(event.target.value); change(() => { const item = data.items.find(item => inScope(item) && (number ? item.pages.includes(number) : !item.pages.length)); if (item) openElement(item, number); else { setPageNo(number); setElementRef(''); reset(empty(), []); } }); }}><option value={0}>페이지 정보 없음 ({c.unlocated})</option>{document.pages.filter(page => !excluded.has(page.number)).map(page => <option key={page.number} value={page.number}>원본 {page.number}페이지</option>)}</select></label><label>요소<select aria-label="개별 검토 요소" value={elementRef} disabled={busy || !pageItems.length} onChange={event => change(() => openElement(itemMap.get(event.target.value)!, pageNo))}>{pageItems.map(item => <option key={item.ref} value={item.ref}>{item.ref} · {item.label} · {(item.text || item.cells[0]?.text || '구조 요소').slice(0, 70)}</option>)}</select></label></div>}
    {mode === 'groups' && !group && <p>반복 후보가 없습니다. 개별 요소 검토에서 전체 대상을 확인하세요.</p>}
    {(group || mode === 'individual') && <>
      {mode === 'groups' && group && <div className="role-group-summary"><strong>{roleNames[group.kind]} 후보 · 전체 {members.length}개 / 범위 내 {activeMembers.length}개 / 선택 {selected.length}개</strong><details><summary>전체 원본 페이지 목록 ({group.pages.length}페이지)</summary><p>{group.pages.join(', ')}</p></details><p>범위 밖 {members.length - activeMembers.length}개는 저장하지 않습니다. 체크를 해제한 예외도 일괄 판단에서 제외합니다.</p></div>}
      <div className="role-workbench">
        <section className="role-source" aria-label="원문·JSON 대조">
          {mode === 'groups' && <label>대표 사례<select aria-label="대표 사례" value={elementRef} onChange={event => { const item = itemMap.get(event.target.value)!; setElementRef(item.ref); setPageNo(item.pages.find(page => !excluded.has(page)) ?? item.pages[0] ?? 0); }}>{members.map(item => <option key={item.ref} value={item.ref}>원본 {item.pages.join(', ')}페이지 · {item.text.slice(0, 55)}</option>)}</select></label>}
          <div className="role-image-wrap">{imagePage?.imageAvailable ? <><img className="role-page-image" src={imagePage.imageUrl} alt={`영역 대조 원본 ${pageNo}페이지`} />{element?.provenance.filter(prov => prov.page === pageNo && prov.rect).map((prov, index) => <div key={index} className="role-bbox" aria-label="선택 요소 위치" style={{ left: `${prov.rect!.left * 100}%`, top: `${prov.rect!.top * 100}%`, width: `${prov.rect!.width * 100}%`, height: `${prov.rect!.height * 100}%` }} />)}</> : <p className="role-no-image">{pageNo ? '원문 이미지가 없습니다. JSON 근거로 확인하세요.' : '페이지 정보가 없습니다. 출처를 추정하지 않습니다.'}</p>}</div>
          {imagePage?.imageAvailable && <Button size="sm" variant="outline" onClick={() => onEnlarge(pageNo)}>원문 크게 보기</Button>}
          {element && <div className="role-original"><strong>{element.ref}</strong><p>원본 라벨 {element.label || '없음'} · layer {element.layer || '없음'}</p><p>원본 소속 {element.parentRef || '없음'} · 자식 {element.children.length}개</p><p>출처 페이지 {element.pages.join(', ') || '없음'}{element.derivedPages ? ' (그룹 자손에서 유도)' : ''}</p>{element.pages.length > 1 && <p>이 요소 판단은 모든 출처 페이지에 적용됩니다.</p>}{!element.provenance.some(prov => prov.page === pageNo && prov.rect) && <p>표시 가능한 좌표가 없습니다. 위치를 추정하지 않습니다.</p>}<details open><summary>JSON 내용 대조</summary><p className="role-original-text">{element.text || element.cells.map(cell => `[${cell.row},${cell.column}] ${cell.text}`).join('\n') || '텍스트 없는 구조 요소'}</p>{element.orig !== element.text && <><strong>orig</strong><p className="role-original-text">{element.orig || '없음'}</p></>}</details><details><summary>원본 출처·연결</summary><pre>{JSON.stringify({ sourceRef: element.sourceRef, provenance: element.provenance.map(({ rect: _rect, page: _page, ...prov }) => prov), children: element.children }, null, 2)}</pre></details></div>}
        </section>
        <section className="role-editor" aria-label={mode === 'groups' ? '선택한 반복 요소 일괄 판단' : '개별 요소 판단'}>
          <h2>{mode === 'groups' ? `선택한 ${selected.length}개 요소의 공통 판단` : '이 요소의 판단'}</h2>
          {mode === 'individual' && saved.get(elementRef)?.needsReview && <p className="restore-hint">페이지 범위가 바뀌어 다시 확인해야 합니다.</p>}
          <label className="field-label" htmlFor="role-status">검수 판단</label><select id="role-status" value={draft.status} disabled={busy} onChange={event => changeDraft({ status: event.target.value as RoleDraft['status'] })}><option value="">판단 선택</option>{Object.entries(statusNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select>
          <label className="field-label" htmlFor="role-region">잠정 영역</label><select id="role-region" value={draft.region} disabled={busy} onChange={event => changeDraft({ region: event.target.value as RoleRegion })}>{Object.entries(regionNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select>
          <label className="field-label" htmlFor="role-value">잠정 큰 역할</label><select id="role-value" value={draft.role} disabled={busy} onChange={event => changeDraft({ role: event.target.value as CoarseRole })}>{Object.entries(roleNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select>
          <label className="field-label" htmlFor="role-parent">잠정 소속</label><select id="role-parent" value={draft.parentRef} disabled={busy} onChange={event => changeDraft({ parentRef: event.target.value })}><option value="">원본 소속 유지</option>{data.targets.filter(target => ['#/body', '#/furniture'].includes(target.ref) || target.ref.startsWith('#/groups/') || target.ref.startsWith('#/tables/') || target.ref.startsWith('#/pictures/')).map(target => <option key={target.ref} value={target.ref}>{target.ref} · {target.label} {target.pages.length ? `· 원본 ${target.pages.join(', ')}` : ''}</option>)}</select>
          <label className="field-label" htmlFor="role-reason">판단 근거·사유 · 필수</label><Textarea id="role-reason" value={draft.reason} maxLength={10000} disabled={busy} onChange={event => changeDraft({ reason: event.target.value })} placeholder="반복 문구·위치, 실제 제목과의 구별 등 확인한 근거" />
          <label className="field-label" htmlFor="role-evidence">사용한 근거</label><select id="role-evidence" value={draft.evidence} disabled={busy} onChange={event => changeDraft({ evidence: event.target.value as RoleDraft['evidence'] })}><option value="json">JSON 내부 근거</option><option value="page_image" disabled={!availableImage}>원문 페이지 이미지</option><option value="both" disabled={!availableImage}>페이지 이미지 + JSON</option></select>
          <label className="field-label" htmlFor="role-followup">후속 확인{['suspected', 'unjudgeable'].includes(draft.status) ? ' · 필수' : ' · 선택'}</label><Textarea id="role-followup" value={draft.followUp} maxLength={10000} disabled={busy} onChange={event => changeDraft({ followUp: event.target.value })} placeholder="불확실한 역할·소속과 필요한 추가 확인" />
          <div className="record-actions"><Button variant="outline" disabled={busy || !dirty} onClick={discard}>판단 초안 취소</Button><Button disabled={busy || !valid || !dirty} onClick={() => void save()}>{mode === 'groups' ? `${selected.length}개 요소 일괄 저장` : '요소 판단 저장'}</Button></div>
          {mode === 'groups' && review.roleUndo && <><p className="panel-footnote">직전 일괄 저장 {review.roleUndo.refs.length}개. 복원은 이 대상의 저장 전 판단으로 되돌립니다.</p><Button variant="outline" disabled={busy || !review.roleUndo.canRestore} onClick={() => change(() => { void onMutate('/api/review/role-groups', { action: 'restore', id: review.roleUndo!.id }); })}>직전 일괄 판단 복원</Button></>}
          <p className="panel-footnote">후보 선택·초안은 판단을 확정하지 않습니다. 원본 교정과 삭제는 수행하지 않습니다.</p>
        </section>
      </div>
      {mode === 'groups' && <section className="role-members" aria-label="반복 후보 대상·예외"><h2>대상별 확인 · 체크 해제로 예외 제외</h2><div className="record-actions"><Button size="sm" variant="outline" disabled={busy} onClick={() => setSelected(activeMembers.map(item => item.ref))}>범위 내 전체 선택</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setSelected([])}>묶음 선택 해제</Button></div>{members.map(item => { const record = saved.get(item.ref), active = inScope(item); return <div className="role-member" key={item.ref}><label><input type="checkbox" aria-label={`${item.ref} 일괄 대상`} disabled={busy || !active} checked={selected.includes(item.ref)} onChange={event => setSelected(event.target.checked ? [...selected, item.ref] : selected.filter(ref => ref !== item.ref))} /><span>원본 {item.pages.join(', ')}페이지 · {item.ref}<small>{item.text}</small></span></label><span>{!active ? '범위 밖' : record?.needsReview ? '재검토' : record ? statusNames[record.status] : '미검수'}</span><Button size="sm" variant="ghost" disabled={busy || !active} aria-label={`${item.ref} 개별 판정`} onClick={() => change(() => openElement(item))}>개별 판정</Button></div>; })}</section>}
    </>}
    <section className="role-completion"><h2>영역 검수 범위와 완료</h2><p>미검수·재검토·의심 항목이 없어야 완료할 수 있습니다. 판단 불가는 이유와 후속 확인을 남깁니다. 제외 페이지는 세부 검수 범위에서 빠집니다.</p><label className="field-label" htmlFor="stage-note">전체 검토 범위·근거·미확인 사항</label><Textarea id="stage-note" value={stageNote} maxLength={10000} disabled={busy} onChange={event => onNote(event.target.value)} /><div className="record-actions"><Button variant="outline" disabled={busy || !stageDirty} onClick={() => onNote(stage.note)}>메모 초안 취소</Button><Button variant="outline" disabled={busy || !stageDirty || dirty} onClick={() => void onStage('save_note')}>메모 저장</Button><Button disabled={busy || dirty || !stageNote.trim() || (stage.status !== 'completed' && !ready)} onClick={() => void onStage(stage.status === 'completed' ? 'reopen' : 'complete')}>{stage.status === 'completed' ? '완료 취소' : '영역 검수 완료 기록'}</Button></div></section>
  </section>;
});
