import { useCallback, useEffect, useState } from "react";
import type { DashboardSnapshot, Member, ShiftFilter } from "../../shared/contracts";
import { formatLocalDate, monthBounds } from "../../domain/time";
import { EmptyState, Hours, PageHeader, StatusPill } from "../components";
import { WeeklySchedule } from "../components/WeeklySchedule";
import { errorMessage } from "../App";

export function DashboardPage({ members }: { members: Member[] }) {
  const now = new Date();
  const bounds = monthBounds(now.getFullYear(), now.getMonth() + 1);
  const [startDate, setStartDate] = useState(bounds.startDate);
  const [endDate, setEndDate] = useState(bounds.endDate);
  const [kind, setKind] = useState<ShiftFilter>("all");
  const [memberId, setMemberId] = useState("");
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const value = await window.checkinApi.getDashboard({
        startDate,
        endDate,
        kind,
        memberId: memberId || undefined,
      });
      setSnapshot(value);
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [endDate, kind, memberId, startDate]);

  useEffect(() => {
    void load();
  }, [load]);

  function setPreset(preset: "today" | "month" | "payroll") {
    if (preset === "today") {
      const today = formatLocalDate(new Date());
      setStartDate(today);
      setEndDate(today);
    } else if (preset === "month") {
      setStartDate(bounds.startDate);
      setEndDate(bounds.endDate);
    } else {
      setStartDate(formatLocalDate(new Date(now.getFullYear(), now.getMonth() - 1, 26)));
      setEndDate(formatLocalDate(new Date(now.getFullYear(), now.getMonth(), 25)));
    }
  }

  return (
    <div className="page-stack">
      <PageHeader title="出勤与计薪工时" />
      <section className="dashboard-filters">
        <div className="preset-buttons">
          <button onClick={() => setPreset("today")}>今日</button>
          <button onClick={() => setPreset("month")}>本月</button>
          <button onClick={() => setPreset("payroll")}>考核周期</button>
        </div>
        <label>开始日期<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
        <label>结束日期<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
        <label>班次<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          <option value="all">全部班次</option><option value="desk">工作日坐班</option><option value="weekend">周末坐班</option><option value="maintenance">维修班</option><option value="overtime">加班</option>
        </select></label>
        <label>成员<select value={memberId} onChange={(event) => setMemberId(event.target.value)}>
          <option value="">全部成员</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select></label>
      </section>

      <WeeklySchedule kind={kind} memberId={memberId} />

      {error && <div className="inline-error" role="alert">{error}</div>}
      {loading && <div className="page-loading compact">正在汇总…</div>}
      {!loading && snapshot && (
        <>
          <section className="metric-grid">
            <div className="metric-cell"><span>已签到计薪工时</span><strong><Hours minutes={snapshot.metrics.paidMinutes} /></strong><small>有效签到班次合计</small></div>
            <div className="metric-cell"><span>加班工时</span><strong><Hours minutes={snapshot.metrics.overtimeMinutes} /></strong><small>已签到或已补记的加班</small></div>
            <div className="metric-cell"><span>到岗率</span><strong>{snapshot.metrics.attendanceRate === null ? "—" : `${(snapshot.metrics.attendanceRate * 100).toFixed(1)}%`}</strong><small>{snapshot.metrics.attendanceRate === null ? "暂无已结束班次" : `${snapshot.metrics.attendedEndedSlots}/${snapshot.metrics.endedSlots} 个已结束席位`}</small></div>
            <div className="metric-cell"><span>迟到次数</span><strong>{snapshot.metrics.lateCount}</strong><small>{snapshot.metrics.manualUnjudgedCount} 条补记未判定</small></div>
            <div className="metric-cell"><span>已结束未签到席位</span><strong>{snapshot.metrics.missingEndedSlots}</strong><small>团队缺口</small></div>
            <div className="metric-cell"><span>请假次数</span><strong>{snapshot.metrics.leaveCount}</strong><small>无代班请假不计缺勤</small></div>
          </section>

          <section className="dashboard-section">
            <div className="card-title-row"><div><h2>成员汇总</h2><p>点击记录可在“签到记录”中更正或撤销。</p></div><StatusPill tone="gray">{snapshot.members.length} 人</StatusPill></div>
            {snapshot.members.length === 0 ? <EmptyState title="暂无成员" description="请先导入成员资料或排班。" /> : (
              <div className="table-scroll"><table><thead><tr><th>姓名</th><th>已签到班次</th><th>常规工时</th><th>加班工时</th><th>总工时</th><th>请假</th><th>迟到</th><th>临时替班</th></tr></thead>
                <tbody>{snapshot.members.map((member) => <tr key={member.memberId}><td><strong>{member.memberName}</strong></td><td>{member.shiftCount}</td><td><Hours minutes={member.regularMinutes} /></td><td><Hours minutes={member.overtimeMinutes} /></td><td><strong><Hours minutes={member.totalMinutes} /></strong></td><td>{member.leaveCount}</td><td>{member.lateCount}</td><td>{member.substituteCount}</td></tr>)}</tbody>
              </table></div>
            )}
          </section>

          <section className="dashboard-section">
            <div className="card-title-row"><div><h2>签到明细</h2><p>实际打卡时间和计薪班次分开显示。</p></div><StatusPill tone="blue">{snapshot.records.length} 条</StatusPill></div>
            {snapshot.records.length === 0 ? <EmptyState title="所选范围暂无签到" description="签到成功后会立即出现在这里。" /> : (
              <div className="table-scroll"><table><thead><tr><th>日期</th><th>班次</th><th>类型/角色</th><th>原排班</th><th>实际人员</th><th>打卡时间</th><th>计薪工时</th><th>状态</th></tr></thead>
                <tbody>{snapshot.records.slice(0, 200).map((record) => <tr key={record.id}><td>{record.date}</td><td>{record.workType === "overtime" ? "加班" : record.label}<small>{record.startTime}-{record.endTime}</small></td><td>{record.workType === "overtime" ? "加班" : "正式班"}<small>{record.slotRole === "staff" ? "办公人员" : record.slotRole === "overtime" ? "加班人员" : "负责人"}</small></td><td>{record.scheduledMemberName ?? "空位"}</td><td><strong>{record.actualMemberName}</strong></td><td>{record.punchTime ? new Date(record.punchTime).toLocaleString("zh-CN", { hour12: false }) : "未填写"}</td><td><Hours minutes={record.paidMinutes} /></td><td><StatusPill tone={record.workType === "overtime" ? "blue" : record.lateStatus === "late" ? "amber" : record.lateStatus === "manual_unjudged" ? "gray" : "green"}>{record.workType === "overtime" ? "加班计薪" : record.lateStatus === "late" ? "迟到" : record.lateStatus === "manual_unjudged" ? "补记未判定" : "正常"}</StatusPill></td></tr>)}</tbody>
              </table></div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
