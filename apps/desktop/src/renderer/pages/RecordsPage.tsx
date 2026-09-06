import { useCallback, useEffect, useMemo, useState } from "react";
import type { AttendanceRecordView, Member, ShiftView } from "../../shared/contracts";
import { formatLocalDate, monthBounds } from "../../domain/time";
import { Card, EmptyState, Hours, PageHeader, StatusPill } from "../components";
import { errorMessage } from "../App";

export function RecordsPage({ members, onChanged }: { members: Member[]; onChanged(): Promise<void> }) {
  const now = new Date();
  const bounds = monthBounds(now.getFullYear(), now.getMonth() + 1);
  const [startDate, setStartDate] = useState(bounds.startDate);
  const [endDate, setEndDate] = useState(bounds.endDate);
  const [memberId, setMemberId] = useState("");
  const [records, setRecords] = useState<AttendanceRecordView[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      setRecords(await window.checkinApi.listRecords({ startDate, endDate, memberId: memberId || undefined, includeRevoked: true }));
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [endDate, memberId, startDate]);

  useEffect(() => { void load(); }, [load]);

  async function mutate(action: () => Promise<unknown>, success: string) {
    try {
      await action();
      setNotice(success);
      setError("");
      await Promise.all([load(), onChanged()]);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <div className="page-stack">
      <PageHeader title="签到记录与改错" description="更正、撤销和人工补记会立即影响看板和未导出的月报；已落盘文件不会自动改变。" />
      <Card className="filter-card">
        <label>开始日期<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
        <label>结束日期<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
        <label>成员<select value={memberId} onChange={(event) => setMemberId(event.target.value)}><option value="">全部成员</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      </Card>
      <ManualEntry members={members} onSaved={() => mutate(async () => undefined, "人工补记已保存")} />
      {notice && <div className="success-banner" role="status">{notice}</div>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      <Card>
        <div className="card-title-row"><div><h2>记录明细</h2><p>人工修改只记录本机来源，不证明操作者身份。</p></div><StatusPill tone="gray">{records.length} 条</StatusPill></div>
        {records.length === 0 ? <EmptyState title="暂无记录" description="调整筛选范围，或先在班内完成签到。" /> : (
          <div className="table-scroll"><table><thead><tr><th>日期与班次</th><th>原排班</th><th>实际人员</th><th>打卡时间</th><th>计薪</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>{records.map((record) => <RecordRow key={record.id} record={record} members={members} onMutate={mutate} />)}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

function RecordRow({ record, members, onMutate }: { record: AttendanceRecordView; members: Member[]; onMutate(action: () => Promise<unknown>, success: string): Promise<void> }) {
  const [memberId, setMemberId] = useState(record.actualMemberId);
  return (
    <tr className={record.status === "revoked" ? "muted-row" : ""}>
      <td><strong>{record.date}</strong><small>{record.label} · {record.startTime}-{record.endTime}</small></td>
      <td>{record.scheduledMemberName ?? "空位"}</td>
      <td><select value={memberId} disabled={record.status === "revoked"} onChange={(event) => setMemberId(event.target.value)}>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></td>
      <td>{record.punchTime ? new Date(record.punchTime).toLocaleString("zh-CN", { hour12: false }) : "补记未填写"}</td>
      <td><Hours minutes={record.paidMinutes} /></td>
      <td><StatusPill tone={record.status === "revoked" ? "red" : record.lateStatus === "late" ? "amber" : record.lateStatus === "manual_unjudged" ? "gray" : "green"}>{record.status === "revoked" ? "已撤销" : record.lateStatus === "late" ? "迟到" : record.lateStatus === "manual_unjudged" ? "补记未判定" : "正常"}</StatusPill></td>
      <td><div className="row-actions">
        {record.status === "active" && memberId !== record.actualMemberId && <button onClick={() => onMutate(() => window.checkinApi.correctRecord(record.id, memberId), "实际人员已更正")}>保存更正</button>}
        {record.status === "active" ? <button className="danger-text" onClick={() => onMutate(() => window.checkinApi.revokeRecord(record.id), "误签已撤销")}>撤销</button> : <button onClick={() => onMutate(() => window.checkinApi.restoreRecord(record.id), "记录已恢复")}>恢复</button>}
      </div></td>
    </tr>
  );
}

function ManualEntry({ members, onSaved }: { members: Member[]; onSaved(): void }) {
  const [date, setDate] = useState(formatLocalDate(new Date()));
  const [shifts, setShifts] = useState<ShiftView[]>([]);
  const [slotId, setSlotId] = useState("");
  const [memberId, setMemberId] = useState("");
  const [punchTime, setPunchTime] = useState("");
  const [error, setError] = useState("");
  const availableSlots = useMemo(() => shifts.flatMap((shift) => shift.slots.filter((slot) => !slot.attendanceId).map((slot) => ({ shift, slot }))), [shifts]);

  useEffect(() => {
    void window.checkinApi.getShiftsForDate(date).then((value) => { setShifts(value); setSlotId(""); setError(""); }).catch((cause) => setError(errorMessage(cause)));
  }, [date]);

  async function save() {
    if (!slotId || !memberId) { setError("请选择班次席位和实际人员"); return; }
    try {
      await window.checkinApi.addManualAttendance({ slotId, memberId, historicalPunchTime: punchTime ? new Date(punchTime).toISOString() : null });
      setSlotId(""); setMemberId(""); setPunchTime(""); setError(""); onSaved();
    } catch (cause) { setError(errorMessage(cause)); }
  }

  return <Card className="manual-card"><div><h2>补记签到</h2><p>只关联已有班次；未填历史打卡时刻时，迟到状态保持“人工补记／未判定”。</p></div>
    <div className="manual-fields">
      <label>班次日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      <label>班次席位<select value={slotId} onChange={(event) => setSlotId(event.target.value)}><option value="">选择未签到席位</option>{availableSlots.map(({ shift, slot }) => <option key={slot.id} value={slot.id}>{shift.startTime}-{shift.endTime} {shift.label} · 原排班 {slot.scheduledMemberName ?? "空位"}</option>)}</select></label>
      <label>实际人员<select value={memberId} onChange={(event) => setMemberId(event.target.value)}><option value="">选择成员</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      <label>历史打卡时刻 可留空<input type="datetime-local" value={punchTime} onChange={(event) => setPunchTime(event.target.value)} /></label>
      <button className="secondary-button" onClick={() => void save()}>保存补记</button>
    </div>{error && <div className="inline-error compact" role="alert">{error}</div>}</Card>;
}

