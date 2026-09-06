import { useEffect, useMemo, useRef, useState } from "react";
import type { Member, ReportDraft, ReportFileKey, ReportFilePreview, ReportPreview, ScoreEntry, Settings } from "../../shared/contracts";
import { defaultReportDraft, scoreTotal, suggestedAttendanceScore } from "../../domain/report";
import { hoursLabel } from "../../domain/time";
import { Hours, PageHeader, StatusPill, Card, EmptyState } from "../components";
import { errorMessage } from "../App";

const FILE_LABELS: Record<ReportFileKey, string> = {
  workReport: "部门工作报表",
  performance: "全员绩效考核表",
  timeRecord: "团队工时记录表",
  schedule: "正式排班表",
  wageAssessment: "工资考核表",
};

export function ReportsPage({ members }: { members: Member[] }) {
  const now = new Date();
  const [draft, setDraft] = useState<ReportDraft>(() => defaultReportDraft(now.getFullYear(), now.getMonth() + 1));
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [activeFile, setActiveFile] = useState<ReportFileKey>("workReport");
  const [saveState, setSaveState] = useState<"loading" | "saving" | "saved" | "error">("loading");
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<Settings>({ attendanceMode: "lenient", lateThresholdMinutes: 15, latePenaltyPoints: 1 });
  const ready = useRef(false);

  useEffect(() => {
    let active = true;
    Promise.all([window.checkinApi.getReportDraft(draft.year, draft.month), window.checkinApi.getSettings()])
      .then(([loaded, loadedSettings]) => {
        if (!active) return;
        setDraft(loaded); setSettings(loadedSettings); ready.current = true; setSaveState("saved");
        return window.checkinApi.previewReports(loaded).then((value) => { if (active) setPreview(value); });
      })
      .catch((cause) => { if (active) { setError(errorMessage(cause)); setSaveState("error"); } });
    return () => { active = false; };
    // The report period is changed through the explicit month controls below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready.current) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      window.checkinApi.saveReportDraft(draft)
        .then(() => window.checkinApi.previewReports(draft))
        .then((value) => { setPreview(value); setSaveState("saved"); setError(""); })
        .catch((cause) => { setError(errorMessage(cause)); setSaveState("error"); });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const activePreview = preview?.files.find((file) => file.key === activeFile) ?? null;

  async function changePeriod(year: number, month: number) {
    try {
      ready.current = false;
      const loaded = await window.checkinApi.getReportDraft(year, month);
      setDraft(loaded);
      setPreview(await window.checkinApi.previewReports(loaded));
      ready.current = true;
      setSaveState("saved");
    } catch (cause) { setError(errorMessage(cause)); ready.current = true; }
  }

  async function chooseOutput() {
    const directory = await window.checkinApi.chooseOutputDirectory();
    if (directory) setDraft((current) => ({ ...current, outputDirectory: directory }));
  }

  async function exportFiles() {
    setError("");
    try {
      setSaveState("saving");
      await window.checkinApi.saveReportDraft(draft);
      const result = await window.checkinApi.exportReports(draft);
      setSaveState("saved");
      const warning = result.warnings.length ? `\n提示：${result.warnings.join("；")}` : "";
      if (window.confirm(`已生成 ${result.files.length} 个文件。${warning}\n是否打开导出文件夹？`)) await window.checkinApi.openPath(result.directory);
    } catch (cause) { setError(errorMessage(cause)); setSaveState("error"); }
  }

  return <div className="page-stack report-page">
    <PageHeader title="输出本月绩效文件" actions={<span className={`save-state ${saveState}`}>{saveState === "loading" ? "正在读取" : saveState === "saving" ? "保存中" : saveState === "saved" ? "已保存" : "保存失败"}</span>} />
    {error && <div className="inline-error" role="alert">{error}</div>}
    {preview?.warnings.map((warning) => <div className="warning-banner" key={warning}>{warning}</div>)}
    <Card className="report-parameters"><div className="card-title-row"><div><h2>本月信息</h2></div></div>
      <div className="form-grid four">
        <label>所属年份<input type="number" min="2000" max="2200" value={draft.year} onChange={(event) => void changePeriod(Number(event.target.value), draft.month)} /></label>
        <label>所属月份<input type="number" min="1" max="12" value={draft.month} onChange={(event) => void changePeriod(draft.year, Number(event.target.value))} /></label>
        <label>填写日期<input type="date" value={draft.fillDate} onChange={(event) => setDraft({ ...draft, fillDate: event.target.value })} /></label>
        <label>填表人/统计者<input list="member-names" value={draft.filler} onChange={(event) => setDraft({ ...draft, filler: event.target.value })} /><datalist id="member-names">{members.map((member) => <option key={member.id} value={member.name} />)}</datalist></label>
        <label>统计开始<input type="date" value={draft.startDate} onChange={(event) => setDraft({ ...draft, startDate: event.target.value })} /></label>
        <label>统计结束<input type="date" value={draft.endDate} onChange={(event) => setDraft({ ...draft, endDate: event.target.value })} /></label>
        <label>部门名称<input value={draft.department} onChange={(event) => setDraft({ ...draft, department: event.target.value })} /></label>
        <label>输出目录<div className="input-button"><input value={draft.outputDirectory} readOnly placeholder="尚未选择" /><button onClick={() => void chooseOutput()}>选择</button></div></label>
      </div>
    </Card>

    <div className={`report-workspace ${activeFile === "performance" || activeFile === "wageAssessment" ? "editor-focused" : ""}`}>
      <aside className="file-sidebar card"><h2>文件清单</h2>{preview?.files.map((file) => { const checked = draft.selectedFiles.includes(file.key); return <div className={`file-item ${activeFile === file.key ? "active" : ""}`} key={file.key}><input type="checkbox" checked={checked} onChange={(event) => setDraft({ ...draft, selectedFiles: event.target.checked ? [...draft.selectedFiles, file.key] : draft.selectedFiles.filter((key) => key !== file.key) })} /><button onClick={() => setActiveFile(file.key)}><strong>{FILE_LABELS[file.key]}</strong><small>{file.fileName}</small></button></div>; })}<button className="primary-button wide" disabled={!draft.outputDirectory || draft.selectedFiles.length === 0} onClick={() => void exportFiles()}>导出所选 {draft.selectedFiles.length} 个文件</button></aside>

      <section className="report-editor card">
        <ReportEditor fileKey={activeFile} draft={draft} setDraft={setDraft} members={members} preview={preview} settings={settings} />
      </section>
      <section className="report-preview card"><div className="preview-header"><div><span className="eyebrow">内容预览</span><h2>{activePreview?.title ?? "正在生成预览"}</h2></div>{activePreview && <StatusPill tone="gray">{activePreview.type.toUpperCase()}</StatusPill>}</div><ContentPreview file={activePreview} /></section>
    </div>
  </div>;
}

function ReportEditor({ fileKey, draft, setDraft, members, preview, settings }: { fileKey: ReportFileKey; draft: ReportDraft; setDraft(value: ReportDraft): void; members: Member[]; preview: ReportPreview | null; settings: Settings }) {
  if (fileKey === "workReport") return <div><h2>部门工作报表</h2><p className="editor-help">每组保留三条，支持多行文字。</p><TripleFields title="完成的工作" values={draft.workItems} onChange={(values) => setDraft({ ...draft, workItems: values })} /><PairedFields draft={draft} setDraft={setDraft} /><TripleFields title="下月安排" values={draft.plans} onChange={(values) => setDraft({ ...draft, plans: values })} /><label>意见建议<textarea rows={4} value={draft.advice} onChange={(event) => setDraft({ ...draft, advice: event.target.value })} /></label></div>;
  if (fileKey === "performance") return <PerformanceEditor draft={draft} setDraft={setDraft} preview={preview} settings={settings} members={members} />;
  if (fileKey === "wageAssessment") return <WageEditor draft={draft} setDraft={setDraft} preview={preview} members={members} />;
  if (fileKey === "timeRecord") return <ReadOnlySource title="团队工时记录表" description="系统计算结果写入 Excel，工时单位为 h。" />;
  return <ReadOnlySource title="正式排班表" description="原始排班 Excel 表格将写入 DOCX。" />;
}

function TripleFields({ title, values, onChange }: { title: string; values: [string, string, string]; onChange(values: [string, string, string]): void }) {
  return <fieldset><legend>{title}</legend>{values.map((value, index) => <textarea key={index} rows={3} aria-label={`${title} ${index + 1}`} value={value} onChange={(event) => { const next = [...values] as [string, string, string]; next[index] = event.target.value; onChange(next); }} />)}</fieldset>;
}

function PairedFields({ draft, setDraft }: { draft: ReportDraft; setDraft(value: ReportDraft): void }) {
  return <fieldset><legend>问题与反思对策</legend>{draft.questions.map((question, index) => <div className="paired-field" key={index}><textarea rows={3} placeholder={`问题 ${index + 1}`} value={question} onChange={(event) => { const next = [...draft.questions] as [string, string, string]; next[index] = event.target.value; setDraft({ ...draft, questions: next }); }} /><textarea rows={3} placeholder={`反思和对策 ${index + 1}`} value={draft.reflections[index]} onChange={(event) => { const next = [...draft.reflections] as [string, string, string]; next[index] = event.target.value; setDraft({ ...draft, reflections: next }); }} /></div>)}</fieldset>;
}

const SCORE_FIELDS: Array<{ key: keyof Pick<ScoreEntry, "attendance" | "hours" | "self" | "peer" | "supervisor" | "activity">; label: string; max: number }> = [{ key: "attendance", label: "考勤", max: 30 }, { key: "hours", label: "工时", max: 10 }, { key: "self", label: "自评", max: 10 }, { key: "peer", label: "互评", max: 20 }, { key: "supervisor", label: "负责人", max: 30 }, { key: "activity", label: "活动", max: 5 }];

function PerformanceEditor({ draft, setDraft, preview, settings, members }: { draft: ReportDraft; setDraft(value: ReportDraft): void; preview: ReportPreview | null; settings: Settings; members: Member[] }) {
  const summaries = preview?.snapshot.members ?? [];
  const defaults = (memberId: string): ScoreEntry => { const summary = summaries.find((item) => item.memberId === memberId); return { attendance: suggestedAttendanceScore(summary?.lateCount ?? 0, settings.latePenaltyPoints), hours: 10, self: 10, peer: 20, supervisor: 30, activity: 0 }; };
  const score = (memberId: string) => draft.scores[memberId] ?? defaults(memberId);
  return <div className="performance-editor"><h2>工时与评分</h2><p className="editor-help">考勤生成建议值，手工修改后保留；活动附加默认 0。</p><div className="table-scroll"><table className="score-table"><thead><tr><th>成员</th>{SCORE_FIELDS.map((field) => <th key={field.key}>{field.label}<small>/{field.max}</small></th>)}<th>总分</th></tr></thead><tbody>{summaries.map((summary) => { const current = score(summary.memberId); return <tr key={summary.memberId}><td><strong>{summary.memberName}</strong><small><Hours minutes={summary.totalMinutes} /> · 迟到 {summary.lateCount}</small></td>{SCORE_FIELDS.map((field) => <td key={field.key}><input type="number" min="0" max={field.max} value={current[field.key] ?? ""} onChange={(event) => setDraft({ ...draft, scores: { ...draft.scores, [summary.memberId]: { ...current, [field.key]: event.target.value === "" ? null : Number(event.target.value), ...(field.key === "attendance" ? { attendanceOverridden: true } : {}) } } })} /></td>)}<td><strong>{scoreTotal(current) ?? "—"}</strong></td></tr>; })}</tbody></table></div><fieldset><legend>月度优秀员工推荐 可不填</legend>{draft.recommendations.map((recommendation, index) => <div className="recommendation-row" key={index}><select value={recommendation.memberId ?? ""} onChange={(event) => { const next = [...draft.recommendations] as ReportDraft["recommendations"]; next[index] = { ...recommendation, memberId: event.target.value || null }; setDraft({ ...draft, recommendations: next }); }}><option value="">不推荐</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select><textarea rows={2} placeholder="推荐原因" value={recommendation.reason} onChange={(event) => { const next = [...draft.recommendations] as ReportDraft["recommendations"]; next[index] = { ...recommendation, reason: event.target.value }; setDraft({ ...draft, recommendations: next }); }} /></div>)}</fieldset></div>;
}

function WageEditor({ draft, setDraft, preview, members }: { draft: ReportDraft; setDraft(value: ReportDraft): void; preview: ReportPreview | null; members: Member[] }) {
  const summaries = preview?.snapshot.members ?? [];
  return <div className="wage-editor"><h2>工资考核表</h2><div className="table-scroll"><table className="wage-editor-table"><thead><tr><th>成员</th><th>系统工时</th><th>工作量</th><th>备注</th></tr></thead><tbody>{members.map((member) => {
    const summary = summaries.find((item) => item.memberId === member.id);
    const systemWorkload = `${hoursLabel(summary?.totalMinutes ?? 0)}h`;
    return <tr key={member.id}><td><strong>{member.name}</strong></td><td>{systemWorkload}</td><td><input aria-label={`${member.name}工作量`} value={draft.wageWorkloads[member.id] ?? systemWorkload} onChange={(event) => setDraft({ ...draft, wageWorkloads: { ...draft.wageWorkloads, [member.id]: event.target.value } })} /></td><td><input aria-label={`${member.name}备注`} value={draft.wageNotes[member.id] ?? ""} placeholder="可留空" onChange={(event) => setDraft({ ...draft, wageNotes: { ...draft.wageNotes, [member.id]: event.target.value } })} /></td></tr>;
  })}</tbody></table></div></div>;
}

function ReadOnlySource({ title, description }: { title: string; description: string }) { return <EmptyState title={title} description={description} />; }

function ContentPreview({ file }: { file: ReportFilePreview | null }) {
  const tables = useMemo(() => file?.tables ?? [], [file]);
  if (!file) return <div className="page-loading compact">正在生成…</div>;
  return <div className="preview-document"><h3>{file.title}</h3>{file.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}{file.warnings.map((warning) => <div className="preview-warning" key={warning}>{warning}</div>)}{tables.map((table) => <div className="preview-table" key={table.title}><h4>{table.title}</h4><div className="table-scroll"><table><thead><tr>{table.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{table.rows.slice(0, 100).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>{table.rows.length > 100 && <p>预览显示前 100 行；导出包含全部 {table.rows.length} 行。</p>}</div>)}</div>;
}
