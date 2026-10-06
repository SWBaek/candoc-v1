import React, { useState } from "react"
import { createRoot } from "react-dom/client"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import source from "./workflow-data.json"
import pageData from "./fixtures.json"

type Heading = { id: string; number: string; title: string; level: number; page: number; parent: string | null; warning?: string }
type PagePreview = { number: number; image: string }
const headings = source.outline as Heading[]
const previewPages = Object.values(pageData.pages) as PagePreview[]
const stages = source.stages
const initialExpanded = ["6", "6.4", "6.4.2", "6.4.2.3"]
const stagePrompts = [
  "입력 문서와 이번 검수의 범위를 확인합니다.",
  "JSON과 참조·출처 구조의 기본 무결성을 확인합니다.",
  "페이지를 살펴보고 문서에 포함할 범위를 정합니다.",
  "머리말·꼬리말·본문·각주의 역할과 큰 소속을 구분합니다.",
  "영역 안의 순서와 페이지를 넘어 이어지는 내용을 확인합니다.",
  "전체 흐름을 보며 제목의 역할과 깊이를 조정하세요.",
  "캡션·주석·각주와 관련 요소의 연결을 확인합니다.",
  "역할과 소속을 기준으로 문단의 분리·병합을 판단합니다.",
  "목록의 번호·들여쓰기·중첩 관계를 확인합니다.",
  "표의 셀 범위와 그림 내부 텍스트의 구조를 확인합니다.",
  "원문 필드와 주변 정의를 대조해 표현의 일관성을 확인합니다.",
  "앞선 판단과 문서 내부 참조 사이의 충돌을 확인합니다.",
  "검토한 범위, 판정 근거와 미확인 사항을 정리합니다.",
]

type PreviewState = { stage: number; completed: number[]; levels: { [id: string]: number }; selected: string; expanded?: string[]; selectedPages?: number[]; excludedPages?: number[] }
const host = (window as unknown as { openai?: { widgetState?: { privateContent?: { workflow?: PreviewState } }; setWidgetState?: (state: unknown) => Promise<unknown> } }).openai
let restored = host?.widgetState?.privateContent?.workflow
if (!restored) { try { restored = JSON.parse(sessionStorage.getItem("candoc-workflow-prototype") ?? "null") ?? undefined } catch {} }

function Workflow() {
  const [stage, setStage] = useState(restored?.stage ?? 5)
  const [completed, setCompleted] = useState(new Set(restored?.completed ?? [0, 1, 2, 3, 4]))
  const [expanded, setExpanded] = useState(new Set(restored?.expanded ?? initialExpanded))
  const [selected, setSelected] = useState(restored?.selected ?? "#/texts/789")
  const [levels, setLevels] = useState<{ [id: string]: number }>(restored?.levels ?? {})
  const [undo, setUndo] = useState<{ [id: string]: number }[]>([])
  const [query, setQuery] = useState("")
  const [message, setMessage] = useState("")
  const [selectedPages, setSelectedPages] = useState(new Set<number>(restored?.selectedPages ?? []))
  const [excludedPages, setExcludedPages] = useState(new Set<number>(restored?.excludedPages ?? []))
  const selectedHeading = headings.find(row => row.id === selected) ?? headings[0]
  const level = (heading: Heading) => levels[heading.id] ?? heading.level
  const parentOf = (heading: Heading) => headings.find(row => row.number === heading.parent)
  const warning = (heading: Heading) => heading.warning ?? (heading.parent && parentOf(heading) && level(heading) <= level(parentOf(heading)!) ? "깊이 확인" : "")
  const children = (number: string) => headings.some(row => row.parent === number)
  const visible = headings.filter(row => {
    if (query.trim()) return `${row.number} ${row.title}`.toLowerCase().includes(query.toLowerCase())
    let parent = row.parent
    while (parent) {
      if (!expanded.has(parent)) return false
      parent = parent.includes(".") ? parent.slice(0, parent.lastIndexOf(".")) : null
    }
    return true
  })

  function chooseStage(next: number) { setStage(next); setMessage("") }
  function toggleBranch(number: string) {
    const next = new Set(expanded)
    next.has(number) ? next.delete(number) : next.add(number)
    setExpanded(next)
  }
  function adjustDepth(direction: number) {
    if (selectedHeading.warning) { setMessage("머리말 여부를 먼저 확인해 주세요."); return }
    const next = Math.max(1, Math.min(8, level(selectedHeading) + direction))
    if (next === level(selectedHeading)) return
    setUndo([...undo, { ...levels }]); setLevels({ ...levels, [selected]: next })
    setMessage(`선택 제목의 시안 깊이를 ${next}로 조정했습니다.`)
  }
  function undoDepth() {
    if (!undo.length) return
    setLevels(undo[undo.length - 1]); setUndo(undo.slice(0, -1)); setMessage("마지막 깊이 조정을 취소했습니다.")
  }
  function toggleComplete() {
    const next = new Set(completed)
    next.has(stage) ? next.delete(stage) : next.add(stage)
    setCompleted(next); setMessage("시안의 단계 상태를 변경했습니다.")
  }
  function savePreview() {
    const snapshot: PreviewState = { stage, completed: [...completed], levels, selected, expanded: [...expanded], selectedPages: [...selectedPages], excludedPages: [...excludedPages] }
    try { sessionStorage.setItem("candoc-workflow-prototype", JSON.stringify(snapshot)) } catch {}
    host?.setWidgetState?.({ modelContent: { stage, completed: [...completed] }, privateContent: { workflow: snapshot } }).catch(() => {})
    setMessage("시안 상태를 저장했습니다. 실제 문서와 검수 기록은 변경되지 않습니다.")
  }
  function togglePage(number: number) {
    const next = new Set(selectedPages)
    next.has(number) ? next.delete(number) : next.add(number)
    setSelectedPages(next)
  }
  function setPageExclusion(excluded: boolean) {
    const next = new Set(excludedPages)
    selectedPages.forEach(number => excluded ? next.add(number) : next.delete(number))
    setExcludedPages(next); setMessage(`선택한 ${selectedPages.size}개 페이지를 시안에서 ${excluded ? "제외" : "복원"}했습니다.`)
  }
  const title = stage === 5 ? "문서 전체 목차" : stage === 2 ? "페이지 선별과 제외" : stages[stage]
  return <div className="wf-shell">
    <aside className="wf-sidebar" aria-label="문서와 전체 검수 과정">
      <div className="wf-wordmark">candoc<span className="wf-wordmark-dot">.</span></div>
      <div className="wf-document"><span className="wf-eyebrow">현재 문서</span><strong>IEEE 1547-2018</strong><span className="wf-muted">{source.pages}페이지 · rule v0.1</span></div>
      <div className="wf-process-heading"><span>검수 과정</span><Badge variant="outline">시연 상태</Badge></div>
      <nav className="wf-steps" aria-label="전체 검수 단계">
        {stages.map((name, number) => <Button key={name} variant="ghost" className={`wf-step ${completed.has(number) ? "wf-step-done" : "wf-step-pending"} ${stage === number ? "wf-step-current" : ""}`} aria-current={stage === number ? "step" : undefined} onClick={() => chooseStage(number)} aria-label={`${String(number).padStart(2,"0")} ${name} · ${completed.has(number) ? "완료" : stage === number ? "진행 중" : "대기"}`}>
          <span className="wf-step-symbol">{completed.has(number) ? "✓" : String(number).padStart(2, "0")}</span><span className="wf-step-name">{name}</span>{stage === number && <span className="wf-current-dot" aria-hidden="true" />}
        </Button>)}
      </nav>
      <div className="wf-sidebar-legend"><span><span className="wf-legend-square" />완료</span><span><b>진행 중</b></span><span className="wf-muted">대기</span></div>
      <div className="wf-sidebar-footer">단계 상태는 화면 비교용입니다.</div>
    </aside>

    <main className="wf-main">
      <header className="wf-topbar"><span>검수 <span className="wf-breadcrumb-separator">/</span> {String(stage).padStart(2, "0")} · {stages[stage]}</span><Badge variant="outline">프로토타입</Badge></header>
      <div className="wf-workspace">
        <div className="wf-page-heading"><div><h1>{title}</h1><p>{stagePrompts[stage]}</p></div></div>

        {stage === 5 && <>
          <div className="wf-outline-toolbar"><Input value={query} onChange={event => setQuery(event.target.value)} placeholder="제목 검색" aria-label="제목 검색" className="wf-search" /><div className="wf-toolbar-buttons"><Button variant="outline" size="sm" onClick={() => setExpanded(new Set(headings.filter(row => children(row.number)).map(row => row.number)))}>모두 펼치기</Button><Button variant="outline" size="sm" onClick={() => setExpanded(new Set())}>모두 접기</Button></div></div>
          <div className="wf-outline" role="tree" aria-label="문서 제목 계층" onKeyDown={event => {
            if (event.target !== event.currentTarget && (event.target as HTMLElement).closest("input")) return
            if (event.ctrlKey && event.key.toLowerCase() === "z") { event.preventDefault(); undoDepth() }
          }}>
            <div className="wf-table-head"><span>제목</span><span>페이지</span><span>검토</span></div>
            {visible.map(row => <div key={row.id} className={`wf-outline-row ${warning(row) ? "wf-row-warning" : ""} ${selected === row.id ? "wf-row-selected" : ""}`} role="treeitem" aria-level={level(row)} aria-selected={selected === row.id} aria-expanded={children(row.number) ? expanded.has(row.number) : undefined}>
              <div className="wf-title-cell" style={{ "--wf-depth": Math.min(level(row) - 1, 5) } as React.CSSProperties}>
                {children(row.number) ? <Button variant="ghost" className="wf-expand" size="sm" aria-label={`${row.number} ${expanded.has(row.number) ? "접기" : "펼치기"}`} onClick={() => toggleBranch(row.number)}>{expanded.has(row.number) ? "⌄" : "›"}</Button> : <span className="wf-leaf-mark" aria-hidden="true">·</span>}
                <button type="button" className="wf-title-button" onClick={() => { setSelected(row.id); setMessage("") }}><span className="wf-section-number">{row.number}</span>{row.title && <span>{row.title}</span>}</button>
                {warning(row) && <Badge variant="outline" className="wf-warning-badge">{warning(row)}</Badge>}
              </div><span className="wf-page-number">{row.page}</span><span className="wf-review-dash">—</span>
            </div>)}
            {!visible.length && <div className="wf-empty-results">일치하는 제목이 없습니다.</div>}
          </div>
          <div className="wf-selection-bar"><div><strong>선택한 제목</strong><span>{selectedHeading.number} {selectedHeading.title}</span></div><span className={warning(selectedHeading) ? "wf-warning-text" : "wf-muted"}>{warning(selectedHeading) === "깊이 확인" ? `상위 제목 level ${level(parentOf(selectedHeading)!)} · 현재 level ${level(selectedHeading)}` : selectedHeading.warning ? "반복 머리말인지 확인이 필요합니다." : `현재 깊이 ${level(selectedHeading)}`}</span></div>
        </>}

        {stage === 2 && <>
          <div className="wf-page-toolbar"><span>대표 페이지 3개 · 원본 번호 유지</span><div className="wf-toolbar-buttons"><Button variant="outline" size="sm" disabled={!selectedPages.size} onClick={() => setPageExclusion(true)}>선택 페이지 제외</Button><Button variant="outline" size="sm" disabled={!selectedPages.size} onClick={() => setPageExclusion(false)}>복원</Button></div></div>
          <div className="wf-page-grid">{previewPages.map(page => <button type="button" key={page.number} className={`wf-page-tile ${selectedPages.has(page.number) ? "wf-page-tile-selected" : ""} ${excludedPages.has(page.number) ? "wf-page-tile-excluded" : ""}`} aria-pressed={selectedPages.has(page.number)} aria-label={`${page.number}페이지 선택`} onClick={() => togglePage(page.number)}><img src={page.image} alt={`원문 ${page.number}페이지 축소본`} /><span className="wf-page-tile-caption"><strong>p.{page.number}</strong><span>{excludedPages.has(page.number) ? "제외" : "포함"}</span></span></button>)}</div>
          <div className="wf-selection-bar"><span>선택 {selectedPages.size}개</span><span className="wf-muted">시안에서 제외 {excludedPages.size}개 · 원본 보존</span></div>
        </>}

        {stage !== 2 && stage !== 5 && <section className="wf-stage-detail"><span className="wf-stage-number">{String(stage).padStart(2, "0")}</span><h2>{stages[stage]}</h2><p>{stagePrompts[stage]}</p><span className="wf-muted">이 단계의 상세 작업 화면은 다음 시안에서 구체화합니다.</span></section>}
        <p className="wf-status-message" aria-live="polite">{message}</p>
      </div>
      <footer className="wf-actionbar"><div className="wf-toolbar-buttons">{stage === 5 && <><Button variant="outline" size="sm" onClick={() => adjustDepth(1)}>깊이 +1</Button><Button variant="outline" size="sm" onClick={() => adjustDepth(-1)}>깊이 −1</Button><Button variant="ghost" size="sm" disabled={!undo.length} onClick={undoDepth}>실행 취소</Button></>}</div><div className="wf-toolbar-buttons"><Button variant="outline" size="sm" onClick={toggleComplete}>{completed.has(stage) ? "완료 표시 해제" : "단계 완료 표시"}</Button><Button size="sm" className="wf-save-button" onClick={savePreview}>시안에 저장</Button></div></footer>
    </main>
  </div>
}

const root = document.getElementById("candoc-review-workflow")
if (root) createRoot(root).render(<Workflow />)
