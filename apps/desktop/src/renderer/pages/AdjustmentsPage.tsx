import { useBusinessVersion } from "../data/invalidation";
import { registerNavigationGuard } from "../data/navigation";
import { AppButton, AppInput, AppSelect, useFeedback } from "../ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  OperationResult,
  LeaveRecordView,
  Member,
  OvertimeEntryView,
  ShiftSlotView,
  ShiftView,
} from "../../shared/contracts";
import { formatLocalDate, hoursLabel } from "../../domain/time";
import { Card, EmptyState, PageHeader, StatusPill } from "../components";
import { errorMessage } from "../App";

export function AdjustmentsPage({
  members,
  onChanged,
  onOpenRecords,
}: {
  members: Member[];
  onChanged(): Promise<void>;
  onOpenRecords(): void;
}) {
  const { notify } = useFeedback();
  const mutationLock = useRef(false);
  useEffect(
    () =>
      registerNavigationGuard(async () => {
        if (!mutationLock.current) return true;
        notify("正在保存请假或加班，请稍候再离开。");
        return false;
      }),
    [notify],
  );
  const loadToken = useRef(0);
  const businessVersion = useBusinessVersion();
  const [date, setDate] = useState(formatLocalDate(new Date()));
  const [overtimeDate, setOvertimeDate] = useState(formatLocalDate(new Date()));
  const [shifts, setShifts] = useState<ShiftView[]>([]);
  const [leaves, setLeaves] = useState<LeaveRecordView[]>([]);
  const [overtime, setOvertime] = useState<OvertimeEntryView[]>([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const token = ++loadToken.current;
    try {
      const [shiftValues, leaveValues, overtimeValues] = await Promise.all([
        window.checkinApi.getShiftsForDate(date),
        window.checkinApi.listLeaves({
          startDate: date,
          endDate: date,
          includeCancelled: true,
        }),
        window.checkinApi.listOvertime({
          startDate: overtimeDate,
          endDate: overtimeDate,
          includeCancelled: true,
        }),
      ]);
      if (token !== loadToken.current) return;
      setShifts(shiftValues.filter((shift) => shift.workType === "regular"));
      setLeaves(leaveValues);
      setOvertime(overtimeValues);
      setError("");
    } catch (cause) {
      if (token === loadToken.current) setError(errorMessage(cause));
      throw cause;
    }
  }, [date, overtimeDate]);

  useEffect(() => {
    void load().catch(() => undefined);
    return () => {
      loadToken.current++;
    };
  }, [load, businessVersion]);

  async function mutate(
    label: string,
    action: () => Promise<unknown>,
    success: string,
  ) {
    if (mutationLock.current) return false;
    mutationLock.current = true;
    setBusy(label);
    setMessage("");
    setError("");
    try {
      const result = (await action()) as Partial<OperationResult> | undefined;
      notify(
        success,
        result?.operation?.canUndo
          ? async () => {
              await window.checkinApi.undoOperation(result.operation!.id);
              await Promise.all([load(), onChanged()]);
            }
          : undefined,
      );
      setMessage(success);
      try {
        await Promise.all([load(), onChanged()]);
      } catch {
        setError("已保存，但刷新失败。请重新加载，不要重复提交。");
      }
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      mutationLock.current = false;
      setBusy("");
    }
  }

  return (
    <div className="page-stack adjustments-page">
      <PageHeader
        title="请假与加班"
        description="调整只作用于具体日期的班次；正式 Excel 排班保持不变。"
      />
      {message && (
        <div className="success-banner" role="status">
          {message}
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}

      <Card className="filter-card adjustment-date-filter">
        <label>
          办理日期
          <AppInput
            type="date"
            aria-label="办理日期"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <span>
          选择日期后可办理正式班次的请假和增员；加班日期请在下方独立选择。
        </span>
      </Card>

      <section className="dashboard-section">
        <div className="card-title-row">
          <div>
            <h2>正式班次调整</h2>
            <p>请假不改写原排班；无代班时从缺勤统计中豁免。</p>
          </div>
          <StatusPill tone="gray">{shifts.length} 个班次</StatusPill>
        </div>
        {shifts.length === 0 ? (
          <EmptyState
            title="当日没有正式班次"
            description="可切换日期，或先导入正式排班。"
          />
        ) : (
          <div className="adjustment-shift-list">
            {shifts.map((shift) => (
              <ShiftAdjustmentCard
                key={shift.id}
                shift={shift}
                members={members}
                busy={busy}
                mutate={mutate}
              />
            ))}
          </div>
        )}
      </section>

      <OvertimePanel
        date={overtimeDate}
        onDateChange={setOvertimeDate}
        members={members}
        entries={overtime}
        busy={busy}
        mutate={mutate}
        onOpenRecords={onOpenRecords}
      />

      {leaves.some((leave) => leave.status === "cancelled") && (
        <section className="dashboard-section">
          <div className="card-title-row">
            <div>
              <h2>已撤销请假</h2>
              <p>历史记录保留，不影响当前统计。</p>
            </div>
          </div>
          <div className="compact-list">
            {leaves
              .filter((leave) => leave.status === "cancelled")
              .map((leave) => (
                <div className="operation-row" key={leave.id}>
                  <span>
                    {leave.startTime}-{leave.endTime} {leave.memberName} ·
                    已撤销
                  </span>
                  <AppButton
                    disabled={Boolean(busy)}
                    onClick={() =>
                      mutate(
                        "restore-leave",
                        () =>
                          window.checkinApi.attendanceAction({
                            type: "restoreLeave",
                            operationId: crypto.randomUUID(),
                            shiftId: leave.shiftId,
                            leaveId: leave.id,
                          }),
                        "请假已恢复",
                      )
                    }
                  >
                    恢复原请假
                  </AppButton>
                </div>
              ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ShiftAdjustmentCard({
  shift,
  members,
  busy,
  mutate,
}: {
  shift: ShiftView;
  members: Member[];
  busy: string;
  mutate(
    label: string,
    action: () => Promise<unknown>,
    success: string,
  ): Promise<boolean>;
}) {
  const [staffMemberId, setStaffMemberId] = useState("");
  return (
    <article className="adjustment-shift-card">
      <header>
        <div>
          <strong>{shift.label}</strong>
          <span>
            {shift.startTime}-{shift.endTime} · {hoursLabel(shift.paidMinutes)}h
          </span>
        </div>
      </header>
      <div className="adjustment-slot-list">
        {shift.slots.map((slot) => (
          <LeaveRow
            key={slot.id}
            shift={shift}
            slot={slot}
            members={members}
            busy={busy}
            mutate={mutate}
          />
        ))}
      </div>
      <div className="inline-add-staff">
        <label>
          添加办公人员
          <AppSelect
            aria-label="添加办公人员"
            value={staffMemberId}
            onChange={(event) => setStaffMemberId(event.target.value)}
          >
            <option value="">选择成员</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </AppSelect>
        </label>
        <AppButton
          disabled={!staffMemberId || Boolean(busy)}
          onClick={() =>
            void mutate(
              `staff-${shift.id}`,
              async () => {
                await window.checkinApi.attendanceAction({
                  type: "addStaff",
                  operationId: crypto.randomUUID(),
                  shiftId: shift.id,
                  memberId: staffMemberId,
                });
                setStaffMemberId("");
              },
              "办公人员已加入本次班次",
            )
          }
        >
          添加
        </AppButton>
      </div>
    </article>
  );
}

function LeaveRow({
  shift,
  slot,
  members,
  busy,
  mutate,
}: {
  shift: ShiftView;
  slot: ShiftSlotView;
  members: Member[];
  busy: string;
  mutate(
    label: string,
    action: () => Promise<unknown>,
    success: string,
  ): Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [replacementMemberId, setReplacementMemberId] = useState(
    slot.leave?.replacementMemberId ?? "",
  );
  const [reason, setReason] = useState(slot.leave?.reason ?? "");
  const ended =
    `${shift.date}T${shift.endTime}` <= localDateTimeKey(new Date());
  const role = slot.role === "staff" ? "办公人员" : "负责人";
  const leave = slot.leave;

  return (
    <div className={`adjustment-slot-row ${leave ? "on-leave" : ""}`}>
      <div>
        <strong>{slot.scheduledMemberName ?? "空位"}</strong>
        <span>
          {role}
          {slot.attendanceId ? ` · 已签到 ${slot.actualMemberName}` : ""}
        </span>
      </div>
      {leave && !editing ? (
        <div className="leave-summary">
          <span>
            请假
            {leave.replacementMemberName
              ? ` · ${leave.replacementMemberName} 代班`
              : " · 无代班"}
            {leave.reason ? ` · ${leave.reason}` : ""}
          </span>
          <div className="row-actions">
            <AppButton
              disabled={Boolean(slot.attendanceId) || Boolean(busy)}
              onClick={() => setEditing(true)}
            >
              修改
            </AppButton>
            <AppButton
              className="danger-text"
              disabled={Boolean(slot.attendanceId) || Boolean(busy)}
              onClick={() =>
                void mutate(
                  `leave-${leave.id}`,
                  () =>
                    window.checkinApi.attendanceAction({
                      type: "cancelLeave",
                      operationId: crypto.randomUUID(),
                      shiftId: shift.id,
                      leaveId: leave.id,
                    }),
                  "请假已撤销",
                )
              }
            >
              撤销
            </AppButton>
          </div>
        </div>
      ) : editing ? (
        <div className="leave-editor">
          <AppSelect
            aria-label="代班人员"
            value={replacementMemberId}
            disabled={ended}
            onChange={(event) => setReplacementMemberId(event.target.value)}
          >
            <option value="">不安排代班</option>
            {members
              .filter((member) => member.id !== slot.scheduledMemberId)
              .map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
          </AppSelect>
          <AppInput
            aria-label="请假原因"
            placeholder="请假原因（可留空）"
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="row-actions">
            <AppButton
              className="primary-button"
              disabled={Boolean(busy)}
              onClick={() =>
                void (async () => {
                  const saved = await mutate(
                    `leave-${slot.id}`,
                    () =>
                      leave
                        ? window.checkinApi.attendanceAction({
                            type: "updateLeave",
                            operationId: crypto.randomUUID(),
                            shiftId: shift.id,
                            leaveId: leave.id,
                            replacementMemberId: replacementMemberId || null,
                            reason,
                          })
                        : window.checkinApi.attendanceAction({
                            type: "createLeave",
                            operationId: crypto.randomUUID(),
                            shiftId: shift.id,
                            slotId: slot.id,
                            replacementMemberId: replacementMemberId || null,
                            reason,
                          }),
                    leave ? "请假已更新" : "请假已登记",
                  );
                  if (saved) setEditing(false);
                })()
              }
            >
              保存
            </AppButton>
            <AppButton onClick={() => setEditing(false)}>取消</AppButton>
          </div>
        </div>
      ) : (
        <div className="row-actions">
          <AppButton
            disabled={Boolean(slot.attendanceId) || Boolean(busy)}
            onClick={() => setEditing(true)}
          >
            办理请假
          </AppButton>
          {slot.role === "staff" && slot.source === "manual" && (
            <AppButton
              className="danger-text"
              disabled={Boolean(slot.attendanceId) || Boolean(busy)}
              onClick={() =>
                void mutate(
                  `remove-${slot.id}`,
                  () =>
                    window.checkinApi.attendanceAction({
                      type: "removeStaff",
                      operationId: crypto.randomUUID(),
                      shiftId: shift.id,
                      slotId: slot.id,
                    }),
                  "办公人员已从本次班次移除",
                )
              }
            >
              移除
            </AppButton>
          )}
        </div>
      )}
    </div>
  );
}

function OvertimePanel({
  date,
  onDateChange,
  members,
  entries,
  busy,
  mutate,
  onOpenRecords,
}: {
  date: string;
  onDateChange(date: string): void;
  members: Member[];
  entries: OvertimeEntryView[];
  busy: string;
  mutate(
    label: string,
    action: () => Promise<unknown>,
    success: string,
  ): Promise<boolean>;
  onOpenRecords(): void;
}) {
  const [memberId, setMemberId] = useState("");
  const [startTime, setStartTime] = useState("18:00");
  const [endTime, setEndTime] = useState("20:00");
  const [note, setNote] = useState("");
  const ended = (entry: OvertimeEntryView) =>
    `${entry.date}T${entry.endTime}` <= localDateTimeKey(new Date());
  return (
    <section className="dashboard-section">
      <div className="card-title-row">
        <div>
          <h2>加班安排</h2>
          <p>
            可预约未来日期；只有签到或人工补记后才计入薪酬工时并进入月报，加班不参与迟到和到岗率。
          </p>
        </div>
      </div>
      <div className="adjustment-date-filter">
        <label>
          加班日期
          <AppInput
            type="date"
            value={date}
            onChange={(event) => onDateChange(event.target.value)}
          />
        </label>
        <span>可预约未来日期；到点实时签到或事后人工补记后才计薪。</span>
      </div>
      <div className="overtime-form">
        <label>
          加班人员
          <AppSelect
            aria-label="加班人员"
            value={memberId}
            onChange={(event) => setMemberId(event.target.value)}
          >
            <option value="">选择成员</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </AppSelect>
        </label>
        <label>
          开始时间
          <AppInput
            type="time"
            aria-label="加班开始时间"
            value={startTime}
            onChange={(event) => setStartTime(event.target.value)}
          />
        </label>
        <label>
          结束时间
          <AppInput
            type="time"
            aria-label="加班结束时间"
            value={endTime}
            onChange={(event) => setEndTime(event.target.value)}
          />
        </label>
        <label className="wide-field">
          备注
          <AppInput
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="可留空"
          />
        </label>
        <AppButton
          className="primary-button"
          disabled={!memberId || !startTime || !endTime || Boolean(busy)}
          onClick={() =>
            void mutate(
              "overtime-create",
              async () => {
                const result = await window.checkinApi.planOvertime({
                  operationId: crypto.randomUUID(),
                  memberId,
                  date,
                  startTime,
                  endTime,
                  note,
                });
                setMemberId("");
                setNote("");
                return result;
              },
              "加班已预约，签到或人工补记后计入薪酬工时",
            )
          }
        >
          添加加班
        </AppButton>
      </div>
      {entries.length === 0 ? (
        <EmptyState
          title="该日期没有加班安排"
          description="可在上方选择日期并指定成员和时段。"
        />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>人员</th>
                <th>时段</th>
                <th>工时</th>
                <th>备注</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  className={entry.status === "cancelled" ? "muted-row" : ""}
                  key={entry.slotId}
                >
                  <td>
                    <strong>{entry.memberName}</strong>
                  </td>
                  <td>
                    {entry.startTime}-{entry.endTime}
                  </td>
                  <td>{hoursLabel(entry.paidMinutes)}h</td>
                  <td>{entry.note || "—"}</td>
                  <td>
                    <StatusPill
                      tone={
                        entry.status === "completed"
                          ? "green"
                          : entry.status === "cancelled"
                            ? "red"
                            : ended(entry)
                              ? "amber"
                              : "blue"
                      }
                    >
                      {entry.status === "completed"
                        ? "已签到"
                        : entry.status === "cancelled"
                          ? "已取消"
                          : ended(entry)
                            ? "待补记"
                            : "待签到"}
                    </StatusPill>
                  </td>
                  <td>
                    <div className="row-actions">
                      {entry.status === "cancelled" && (
                        <AppButton
                          disabled={Boolean(busy)}
                          onClick={() =>
                            mutate(
                              "restore-overtime",
                              () =>
                                window.checkinApi.attendanceAction({
                                  type: "restoreOvertime",
                                  operationId: crypto.randomUUID(),
                                  shiftId: entry.shiftId,
                                  slotId: entry.slotId,
                                }),
                              "原加班安排已恢复",
                            )
                          }
                        >
                          恢复
                        </AppButton>
                      )}
                      {entry.status === "planned" && ended(entry) && (
                        <AppButton onClick={onOpenRecords}>
                          去人工补记
                        </AppButton>
                      )}
                      {entry.status === "planned" && (
                        <AppButton
                          className="danger-text"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void mutate(
                              `overtime-${entry.slotId}`,
                              () =>
                                window.checkinApi.attendanceAction({
                                  type: "cancelOvertime",
                                  operationId: crypto.randomUUID(),
                                  shiftId: entry.shiftId,
                                  slotId: entry.slotId,
                                }),
                              "加班安排已取消",
                            )
                          }
                        >
                          取消
                        </AppButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function localDateTimeKey(date: Date): string {
  return `${formatLocalDate(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
