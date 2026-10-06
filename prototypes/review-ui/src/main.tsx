import React, { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import data from "./fixtures.json"

type Layout = "workbench" | "source" | "focus"
type Box = { l: number; r: number; t: number; b: number; coord_origin: string }
type Element = { self_ref: string; text: string; orig: string; label: string; parent: { $ref: string }; level?: number; marker?: string; prov: { page_no: number; bbox: Box }[] }
type Page = { number: number; width: number; height: number; image: string; elements: Element[] }
type Record = { verdict: string; note: string; status: string }
type WidgetSnapshot = { modelContent?: unknown; privateContent?: { records?: { [key: string]: Record } } }
declare global {
  interface Window {
    openai?: { widgetState?: WidgetSnapshot; setWidgetState?: (state: WidgetSnapshot) => Promise<unknown> }
  }
}

const pages = data.pages as unknown as { [key: string]: Page }
const stages = ["대상과 범위", "기본 무결성", "영역·큰 역할·소속", "읽기 순서·페이지 연결", "제목·문서 개요", "요소 관계", "단락·문장 경계", "목록 내부 구조", "표·그림 내부 구조", "표현·내부 일관성", "문서 전체 교차 확인", "결과 판정·기록"]
const criteria = ["대상 문서와 검사 범위를 확인합니다.", "JSON 파싱과 참조·출처 구조를 확인합니다.", "반복 문구와 위치를 함께 확인하고, 본문 제목과 구분합니다.", "본문·각주·머리말의 역할을 구분한 뒤 순서를 판단합니다.", "제목 여부를 먼저 판단한 뒤 수준과 상하 관계를 검토합니다.", "좌표, 내용, 참조를 함께 사용해 캡션·주석의 소속을 판단합니다.", "역할과 소속을 확인한 뒤 문단의 분리와 병합을 판단합니다.", "항목 번호·들여쓰기·문장 관계를 함께 확인합니다.", "빈칸만으로 누락을 판단하지 않고 셀 범위와 소속을 확인합니다.", "원문 필드와 주변 정의를 대조해 변환 결과의 일관성을 확인합니다.", "앞선 판단과 문서 내부 참조 사이의 충돌을 확인합니다.", "검사한 범위와 미확인 사항을 구분해 기록합니다."]
const issues = [
  { id: "INS-004", title: "반복 머리말의 제목 분류", short: "머리말 분류", page: 18, stage: 2, ref: "#/texts/158", refs: ["#/texts/158", "#/texts/159"], evidence: "본문 제목으로 저장된 문구가 여러 페이지 상단에 반복됩니다. 위치와 반복 여부를 대조해 머리말인지 확인합니다.", followup: "본문의 실제 문서 제목과 구별한 뒤 제목 계층을 다시 검토합니다." },
  { id: "INS-009", title: "그림 주석과 캡션 연결", short: "캡션 연결", page: 19, stage: 5, ref: "#/texts/228", refs: ["#/texts/172", "#/texts/228"], evidence: "그림에는 NOTE 1이 캡션으로 연결되어 있고, Figure 2 제목은 본문 소속으로 남아 있습니다. 그림 주석과 제목의 역할을 대조합니다.", followup: "그림의 captions 연결과 주석 소속을 함께 확인합니다." },
  { id: "INS-007", title: "목록 하위 항목의 평탄화", short: "목록 중첩", page: 33, stage: 7, ref: "#/texts/515", refs: ["#/texts/514", "#/texts/515", "#/texts/516"], evidence: "b) 뒤의 1), 2)가 같은 목록의 직접 자식으로 저장되어 있습니다. 더 깊은 들여쓰기와 ‘subject to the following’의 관계를 확인합니다.", followup: "목록 구조를 판단한 뒤 해당 항목의 조건 관계를 다시 확인합니다." },
]
const blank = (): Record => ({ verdict: "", note: "", status: "미검토" })
let saved = window.openai?.widgetState?.privateContent?.records ?? {}

function App({ layout }: { layout: Layout }) {
  const [index, setIndex] = useState(0)
  const [stage, setStage] = useState(2)
  const [selectedRef, setSelectedRef] = useState(issues[0].ref)
  const [records, setRecords] = useState<{ [key: string]: Record }>(saved)
  const [verdict, setVerdict] = useState("")
  const [note, setNote] = useState("")
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [view, setView] = useState("source")
  const [boxes, setBoxes] = useState(true)
  const [scope, setScope] = useState("issues")
  const issue = issues[index]
  const page = pages[String(issue.page)]
  const selected = page.elements.find(element => element.self_ref === selectedRef) ?? page.elements[0]
  const recordKey = `${layout}:${selectedRef}:${stage}`
  const record = records[recordKey] ?? blank()
  const related = page.elements.filter(element => issue.refs.includes(element.self_ref))
  const sampleCount = issues.filter(item => records[`${layout}:${item.ref}:${item.stage}`]?.status === "검토 완료").length

  useEffect(() => {
    const next = records[recordKey] ?? blank()
    setVerdict(next.verdict); setNote(next.note); setMessage(""); setError("")
  }, [recordKey])

  function chooseIssue(nextIndex: number) {
    setIndex(nextIndex); setSelectedRef(issues[nextIndex].ref); setStage(issues[nextIndex].stage)
    setView("source")
  }
  function selectElement(ref: string) { setSelectedRef(ref) }
  function saveReview() {
    if (!verdict) { setError("판정을 선택해 주세요."); return }
    const next = { ...records, [recordKey]: { verdict, note, status: "검토 완료" } }
    setRecords(next); saved = { ...saved, ...next }; setError("")
    setMessage("시안에 기록했습니다. 실제 검수 기록은 변경되지 않습니다.")
    window.openai?.setWidgetState?.({ modelContent: { layout, issue: issue.id, stage, verdict }, privateContent: { records: saved } }).catch(() => {})
  }
  function markForRecheck() {
    const next = { ...records, [recordKey]: { verdict: record.verdict, note: record.note, status: "재검토 필요" } }
    setRecords(next); saved = { ...saved, ...next }
    setMessage("이 시안에서 재검토 대상으로 표시했습니다.")
    window.openai?.setWidgetState?.({ modelContent: { layout, issue: issue.id, stage, status: "재검토 필요" }, privateContent: { records: saved } }).catch(() => {})
  }

  function IssueChoices({ strip = false }: { strip?: boolean }) {
    return <div className={strip ? "cd-issue-strip" : "cd-issue-list"} aria-label="대표 의심 항목">
      {issues.map((item, itemIndex) => <Button key={item.id} variant="ghost" className={"cd-issue-choice " + (index === itemIndex ? "cd-selected" : "")} aria-pressed={index === itemIndex} onClick={() => chooseIssue(itemIndex)}>
        <span className="cd-row cd-small"><span className="cd-mono">{item.id}</span><span className="cd-muted">p.{item.page}</span></span>
        <span className="cd-choice-title">{strip ? item.short : item.title}</span>
      </Button>)}
    </div>
  }

  function Elements() {
    return <div className="cd-elements">
      {page.elements.map(element => <Button key={element.self_ref} variant="ghost" className={"cd-element-choice " + (selectedRef === element.self_ref ? "cd-selected" : "")} aria-pressed={selectedRef === element.self_ref} onClick={() => selectElement(element.self_ref)}>
        <span className="cd-small cd-muted cd-mono">{element.self_ref}</span>
        <span className="cd-element-text">{element.marker ? element.marker + " " : ""}{element.text}</span>
      </Button>)}
    </div>
  }

  function SourcePage() {
    const highlighted = page.elements.filter(element => issue.refs.includes(element.self_ref) || element.self_ref === selectedRef)
    return <div className="cd-source-stage">
      <div className="cd-paper">
        <img src={page.image} alt={`IEEE 1547-2018 원문 ${page.number}페이지`} width="900" height="1165" />
        {boxes && highlighted.flatMap(element => element.prov.filter(prov => prov.page_no === page.number).map((prov, boxIndex) => {
          const box = prov.bbox
          const top = box.coord_origin === "BOTTOMLEFT" ? page.height - box.t : box.t
          const height = Math.abs(box.t - box.b)
          return <button type="button" key={`${element.self_ref}:${boxIndex}`} className={"cd-box " + (selectedRef === element.self_ref ? "cd-box-selected" : "")} aria-label={`원문 요소 선택 ${element.self_ref}`} onClick={() => selectElement(element.self_ref)} style={{ left: `${box.l / page.width * 100}%`, top: `${top / page.height * 100}%`, width: `${(box.r - box.l) / page.width * 100}%`, height: `${height / page.height * 100}%` }} />
        }))}
      </div>
      <div className="cd-image-caption"><span>원문 이미지 · p.{page.number}</span><span className="cd-mono">선택 {selectedRef}</span></div>
    </div>
  }

  function Context() {
    return <div className="cd-context">
      <div className="cd-overline">선택 요소</div>
      <p className="cd-selected-text">{selected.marker && <strong>{selected.marker} </strong>}{selected.text}</p>
      <div className="cd-overline">같이 확인할 요소</div>
      {related.filter(element => element.self_ref !== selectedRef).map(element => <button type="button" className="cd-related cursor-interaction" key={element.self_ref} onClick={() => selectElement(element.self_ref)}><span className="cd-small cd-mono">{element.self_ref}</span><span>{element.marker ? element.marker + " " : ""}{element.text}</span></button>)}
      <div className="cd-rule"><span className="cd-overline">현재 단계의 판단 기준</span><p>{criteria[stage]}</p></div>
    </div>
  }

  function Viewer() {
    return <section className="cd-viewer" aria-label="원문과 변환 결과">
      <div className="cd-viewer-top"><span className="cd-small">p.{page.number} / 138</span><Button size="sm" variant={boxes ? "secondary" : "outline"} aria-pressed={boxes} onClick={() => setBoxes(!boxes)}>좌표 {boxes ? "표시" : "숨김"}</Button></div>
      <Tabs value={view} onValueChange={setView} className="cd-view-tabs">
        <TabsList aria-label="문서 보기"><TabsTrigger value="source">원문</TabsTrigger><TabsTrigger value="context">내용</TabsTrigger><TabsTrigger value="json">JSON</TabsTrigger></TabsList>
        <TabsContent value="source">{SourcePage()}</TabsContent>
        <TabsContent value="context">{Context()}</TabsContent>
        <TabsContent value="json"><pre className="cd-json">{JSON.stringify({ self_ref: selected.self_ref, label: selected.label, level: selected.level, parent: selected.parent, text: selected.text, prov: selected.prov }, null, 2)}</pre></TabsContent>
      </Tabs>
      <div className="cd-view-selection"><span className="cd-small cd-muted">현재 JSON</span><Badge variant="outline">{selected.label}</Badge>{selected.level !== undefined && <Badge variant="outline">level {selected.level}</Badge>}<span className="cd-small cd-mono">{selected.parent.$ref}</span></div>
    </section>
  }

  function Evidence({ condensed = false }: { condensed?: boolean }) {
    if (!issue.refs.includes(selectedRef)) {
      return <section className="cd-evidence" aria-label="검토 근거"><div className="cd-row"><span className="cd-small cd-mono">{selectedRef}</span><Badge variant="outline">페이지 요소</Badge></div><h2>선택 요소 검토</h2><p>{criteria[stage]}</p></section>
    }
    return <section className="cd-evidence" aria-label="검토 근거">
      <div className="cd-row"><span className="cd-small cd-mono">{issue.id}</span><Badge variant="outline">기존 의심</Badge></div>
      <h2>{issue.title}</h2>
      <p>{issue.evidence}</p>
      {!condensed && <div className="cd-followup"><span className="cd-overline">판단 이후 확인</span><p>{issue.followup}</p></div>}
    </section>
  }

  function Judgement({ horizontal = false }: { horizontal?: boolean }) {
    return <section className={"cd-judgement " + (horizontal ? "cd-judgement-horizontal" : "")} aria-label="검토 판정">
      <Tabs defaultValue="judgement">
        <TabsList aria-label="검토 도구"><TabsTrigger value="judgement">판정</TabsTrigger><TabsTrigger value="ai">AI 검토</TabsTrigger></TabsList>
        <TabsContent value="judgement">
          <div className="cd-judgement-fields">
            <div className="cd-verdict-area">
              <div className="cd-row cd-field-title"><span>검토 상태</span><Badge variant={record.status === "미검토" ? "outline" : "secondary"}>{record.status}</Badge></div>
              <div className="cd-field-title" id={`${layout}-verdict`}>판정</div>
              <div className="cd-verdicts" role="group" aria-labelledby={`${layout}-verdict`}>
                {["정상", "오류 확인", "의심", "판단 불가"].map(value => <Button key={value} variant={verdict === value ? "default" : "outline"} size="sm" aria-pressed={verdict === value} onClick={() => { setVerdict(value); setError("") }}>{value}</Button>)}
              </div>
            </div>
            <div className="cd-note-area"><label className="cd-field-title" htmlFor={`${layout}-note`}>근거·추가 확인</label><Textarea id={`${layout}-note`} value={note} onChange={event => setNote(event.target.value)} placeholder="판단 근거를 남겨 주세요." rows={3} /></div>
          </div>
          {error && <p className="cd-error" role="alert">{error}</p>}
          <div className="cd-save-row"><Button size="sm" onClick={saveReview}>시안에 기록</Button><Button size="sm" variant="ghost" disabled={record.status === "미검토"} onClick={markForRecheck}>재검토 표시</Button></div>
          <p className="cd-save-message cd-small" aria-live="polite">{message}</p>
        </TabsContent>
        <TabsContent value="ai"><div className="cd-ai-placeholder"><Badge variant="outline">연결 예정</Badge><p>선택 요소, 원문 좌표, 검토 근거를 AI와 함께 살펴보는 공간입니다.</p><Button variant="outline" size="sm" disabled>AI에게 검토 요청</Button></div></TabsContent>
      </Tabs>
    </section>
  }

  const names = { workbench: "목록 · 원문 · 판정", source: "원문을 넓게, 판정은 옆에서", focus: "한 단계, 한 항목에 집중" }
  return <div className={`cd-app cd-layout-${layout}`}>
    <header className="cd-app-header">
      <div className="cd-brand"><span className="cd-brand-mark">C</span><div><span className="cd-product-name">CanDoc</span><span className="cd-small cd-muted">IEEE 1547-2018</span></div><Badge variant="outline">검수 시안</Badge></div>
      <div className="cd-header-meta"><span className="cd-small cd-muted">rule v0.1</span><span className="cd-small">대표 항목 {sampleCount}/3 검토</span></div>
    </header>
    <div className="cd-stage-bar"><label htmlFor={`${layout}-stage`} className="cd-small cd-muted">검수 단계</label><select id={`${layout}-stage`} value={stage} onChange={event => setStage(Number(event.target.value))}>{stages.map((name, number) => <option key={name} value={number}>{String(number).padStart(2, "0")} · {name}</option>)}</select><span className="cd-small cd-layout-caption">{names[layout]}</span></div>

    {layout === "workbench" && <div className="cd-workbench-body">
      <aside className="cd-navigation"><Tabs value={scope} onValueChange={setScope}><TabsList aria-label="검토 대상"><TabsTrigger value="issues">의심 항목</TabsTrigger><TabsTrigger value="elements">페이지 요소</TabsTrigger></TabsList><TabsContent value="issues"><p className="cd-small cd-muted cd-nav-label">대표 사례 3개</p>{IssueChoices({})}</TabsContent><TabsContent value="elements"><p className="cd-small cd-muted cd-nav-label">p.{page.number} · {page.elements.length}개 텍스트</p>{Elements()}</TabsContent></Tabs><div className="cd-nav-note">의심 목록과 전체 검사 범위를 구분해 확인합니다.</div></aside>
      {Viewer()}
      <aside className="cd-inspector">{Evidence({})}{Judgement({})}</aside>
    </div>}

    {layout === "source" && <>{IssueChoices({ strip: true })}<div className="cd-source-body">{Viewer()}<aside className="cd-inspector">{Evidence({})}<div className="cd-inline-elements"><div className="cd-overline">관련 요소 선택</div>{related.map(element => <Button key={element.self_ref} variant={selectedRef === element.self_ref ? "secondary" : "outline"} size="sm" onClick={() => selectElement(element.self_ref)}>{element.self_ref}</Button>)}</div>{Judgement({})}</aside></div></>}

    {layout === "focus" && <>
      <div className="cd-focus-heading"><div><span className="cd-overline">현재 항목 {index + 1} / 3</span><h2>{issue.title}</h2></div><div className="cd-row"><Button size="sm" variant="outline" disabled={index === 0} onClick={() => chooseIssue(index - 1)}>이전</Button><Button size="sm" variant="outline" disabled={index === issues.length - 1} onClick={() => chooseIssue(index + 1)}>다음</Button></div></div>
      <div className="cd-focus-body">{Viewer()}<div className="cd-focus-context">{Evidence({ condensed: true })}{Context()}</div></div>
      {Judgement({ horizontal: true })}
    </>}
    <footer className="cd-footer"><span>배치 비교용 시안 · 실제 검수 기록에 반영되지 않습니다.</span><span>원본 보존</span></footer>
  </div>
}

for (const id of ["candoc-three-panel", "candoc-source-first", "candoc-step-focus"]) {
  const root = document.getElementById(id)
  if (root) createRoot(root).render(<App layout={root.dataset.layout as Layout} />)
}
