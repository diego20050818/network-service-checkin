import { useEffect, useState } from "react";
import type { BootstrapData, Member, Settings } from "../../shared/contracts";
import { formatLocalDate } from "../../domain/time";
import { Card, EmptyState, PageHeader, StatusPill } from "../components";
import { errorMessage } from "../App";

export function DataPage({ data, onChanged }: { data: BootstrapData; onChanged(): Promise<void> }) {
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  const [effectiveDate, setEffectiveDate] = useState(formatLocalDate(now));
  const [settings, setSettings] = useState<Settings>(data.settings);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<Member | null>(null);

  useEffect(() => setSettings(data.settings), [data.settings]);

  async function run(label: string, action: () => Promise<string | null>) {
    setBusy(label); setError(""); setMessage("");
    try {
      const result = await action();
      if (result) setMessage(result);
      await onChanged();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(""); }
  }

  return <div className="page-stack">
    <PageHeader title="排班与成员" description="重新上传是正式排班的唯一修改入口；解析失败不会删除旧排班。" actions={<button className="text-button" onClick={() => void window.checkinApi.openDataDirectory()}>打开数据目录</button>} />
    {message && <div className="success-banner" role="status">{message}</div>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="two-column-grid">
      <Card><div className="card-title-row"><div><h2>导入正式排班</h2><p>支持工作日坐班、周一至周日维修班和按周次轮换的周末坐班。</p></div><StatusPill tone="blue">Excel</StatusPill></div>
        <div className="form-grid two"><label>排班月份<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><label>生效日期<input type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} /></label></div>
        <div className="button-row"><button className="primary-button" disabled={Boolean(busy)} onClick={() => run("schedule", async () => { const result = await window.checkinApi.chooseAndImportSchedule({ month, effectiveDate }); return result ? `${result.duplicate ? "该文件已导入" : "排班导入成功"}：${result.shiftCount} 个班次、${result.slotCount} 个席位${result.warnings.length ? `；${result.warnings.join("；")}` : ""}` : null; })}>{busy === "schedule" ? "正在解析…" : "选择排班文件"}</button><button className="text-button" disabled={Boolean(busy)} onClick={() => run("schedule-template", async () => { const path = await window.checkinApi.saveImportTemplate("schedule"); return path ? `排班模板已保存：${path}` : null; })}>下载排班模板</button></div>
      </Card>
      <Card><div className="card-title-row"><div><h2>导入成员资料</h2><p>姓名、学院、职务、短号和学号等按文本保存；排班中的新姓名会建立最小资料。</p></div><StatusPill tone="gray">可选</StatusPill></div>
        <div className="button-row"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => run("members", async () => { const result = await window.checkinApi.chooseAndImportMembers(); return result ? `成员导入完成：新增 ${result.created}、更新 ${result.updated}` : null; })}>{busy === "members" ? "正在导入…" : "选择成员信息表"}</button><button className="text-button" disabled={Boolean(busy)} onClick={() => run("members-template", async () => { const path = await window.checkinApi.saveImportTemplate("members"); return path ? `人员模板已保存：${path}` : null; })}>下载人员模板</button></div>
      </Card>
    </div>

    <Card><div className="card-title-row"><div><h2>成员资料</h2><p>同名人员应使用各自稳定 ID，不仅凭姓名合并。</p></div><button className="text-button" onClick={() => setEditing(emptyMember())}>新增成员</button></div>
      {data.members.length === 0 ? <EmptyState title="暂无成员" description="可以导入成员表，也可以新增一名成员。" /> : <div className="member-chips">{data.members.map((member) => <button key={member.id} onClick={() => setEditing(member)}><strong>{member.name}</strong><small>{member.role || "职务未填"} · {member.college || "学院未填"}</small></button>)}</div>}
      {editing && <MemberEditor member={editing} onCancel={() => setEditing(null)} onSave={(member) => run("member-save", async () => { await window.checkinApi.saveMember(member); setEditing(null); return "成员资料已保存"; })} />}
    </Card>

    <Card><div className="card-title-row"><div><h2>签到与迟到设置</h2><p>新设置会应用到尚未开始且没有签到记录的班次，既有记录不重算。</p></div></div>
      <div className="form-grid"><label>签到模式<select value={settings.attendanceMode} onChange={(event) => setSettings({ ...settings, attendanceMode: event.target.value as Settings["attendanceMode"] })}><option value="lenient">宽松模式</option><option value="late_mark">迟到标记模式</option></select></label><label>开班后多少分钟算迟到<input type="number" min="0" max="180" value={settings.lateThresholdMinutes} onChange={(event) => setSettings({ ...settings, lateThresholdMinutes: Number(event.target.value) })} /></label><label>每次迟到建议扣分<input type="number" min="0" max="30" step="0.5" value={settings.latePenaltyPoints} onChange={(event) => setSettings({ ...settings, latePenaltyPoints: Number(event.target.value) })} /></label></div>
      <button className="secondary-button" disabled={Boolean(busy)} onClick={() => run("settings", async () => { setSettings(await window.checkinApi.updateSettings(settings)); return "设置已保存"; })}>保存设置</button>
    </Card>
  </div>;
}

function emptyMember(): Member {
  return { id: "", name: "", college: "", role: "", phone: "", studentId: "", major: "", grade: "", employeeNo: "", active: true };
}

function MemberEditor({ member, onCancel, onSave }: { member: Member; onCancel(): void; onSave(member: Partial<Member> & { name: string }): Promise<void> }) {
  const [value, setValue] = useState(member);
  const fields: Array<{ key: keyof Member; label: string }> = [
    { key: "name", label: "姓名" }, { key: "college", label: "所属学院" }, { key: "role", label: "职务" }, { key: "phone", label: "电话/短号" }, { key: "studentId", label: "学号" }, { key: "major", label: "专业" }, { key: "grade", label: "年级" }, { key: "employeeNo", label: "工号" },
  ];
  return <div className="editor-panel"><h3>{member.id ? `编辑 ${member.name}` : "新增成员"}</h3><div className="form-grid four">{fields.map((field) => <label key={field.key}>{field.label}<input value={String(value[field.key] ?? "")} onChange={(event) => setValue({ ...value, [field.key]: event.target.value })} /></label>)}</div><div className="button-row"><button className="primary-button" disabled={!value.name.trim()} onClick={() => void onSave({ ...value, id: value.id || undefined })}>保存</button><button className="text-button" onClick={onCancel}>取消</button></div></div>;
}
