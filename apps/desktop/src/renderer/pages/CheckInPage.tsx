import { useEffect, useMemo, useState } from "react";
import type { BootstrapData, CheckInSelection, ShiftView } from "../../shared/contracts";
import { formatLocalTime, hoursLabel, isWithinShift } from "../../domain/time";
import { EmptyState } from "../components";
import { errorMessage } from "../App";

interface Props {
  data: BootstrapData;
  onChanged(): Promise<void>;
  onOpenRecords(): void;
  onOpenData(): void;
}

export function CheckInPage({ data, onChanged, onOpenRecords, onOpenData }: Props) {
  const [now, setNow] = useState(new Date());
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => { void onChanged(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [onChanged]);

  const dateLabel = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(now);
  const timeLabel = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now);

  return (
    <div className="checkin-page">
      <header className="checkin-toolbar">
        <div>
          <span className="eyebrow">今天</span>
          <h1>{dateLabel}</h1>
        </div>
        <div className="checkin-now" aria-label={`当前时间 ${timeLabel}`}>
          <strong>{timeLabel}</strong>
          <span>本机时间</span>
        </div>
      </header>

      {message && <div className="success-banner" role="status">{message}</div>}
      {error && <div className="inline-error" role="alert">{error}</div>}

      <section className="day-agenda">
        <div className="day-agenda-heading">
          <div>
            <h1>{data.todayShifts.length ? `今日共 ${data.todayShifts.length} 个班次` : "今日无班次"}</h1>
          </div>
          <button className="text-button" onClick={onOpenRecords}>今日记录</button>
        </div>

        {data.todayShifts.length > 0 ? (
          <div className="day-agenda-table">
            <div className="day-agenda-columns" aria-hidden="true"><span>时间</span><span>班次与签到</span></div>
            {data.todayShifts.map((shift) => (
              <ShiftAgendaRow
                key={shift.id}
                shift={shift}
                members={data.members}
                now={now}
                onSuccess={async (text) => {
                  setMessage(text);
                  setError("");
                  await onChanged();
                  window.setTimeout(() => setMessage(""), 3_000);
                }}
                onError={(text) => {
                  setError(text);
                  setMessage("");
                }}
              />
            ))}
          </div>
        ) : (
          <div className="calendar-surface empty-day-agenda">
            <EmptyState
              title="今天没有排班"
              description="导入正式排班后，这里会显示当天的全部班次和负责人。"
              action={<button className="primary-button" onClick={onOpenData}>导入排班</button>}
            />
          </div>
        )}
      </section>
    </div>
  );
}

function ShiftAgendaRow({
  shift,
  members,
  now,
  onSuccess,
  onError,
}: {
  shift: ShiftView;
  members: BootstrapData["members"];
  now: Date;
  onSuccess(text: string): Promise<void>;
  onError(text: string): void;
}) {
  const [selected, setSelected] = useState<Record<string, { enabled: boolean; memberId: string }>>(() =>
    Object.fromEntries(
      shift.slots.map((slot) => [
        slot.id,
        {
          enabled: shift.slots.length === 1 && !slot.attendanceId,
          memberId: slot.actualMemberId ?? slot.scheduledMemberId ?? "",
        },
      ]),
    ),
  );
  const [submitting, setSubmitting] = useState(false);
  const completed = shift.slots.filter((slot) => slot.attendanceId).length;
  const localTime = formatLocalTime(now);
  const phase = localTime < shift.startTime ? "upcoming" : isWithinShift(localTime, shift.startTime, shift.endTime) ? "current" : "ended";
  const phaseLabel = completed === shift.slots.length ? "已完成" : phase === "current" ? "可签到" : phase === "upcoming" ? "未到班" : "已结束";
  const phaseTone = completed === shift.slots.length ? "green" : phase === "current" ? "blue" : phase === "upcoming" ? "gray" : "red";
  const responsible = shift.slots.map((slot) => slot.scheduledMemberName ?? "空位").join("、");
  const selections = useMemo<CheckInSelection[]>(
    () =>
      shift.slots
        .filter((slot) => !slot.attendanceId && selected[slot.id]?.enabled && selected[slot.id]?.memberId)
        .map((slot) => ({ slotId: slot.id, memberId: selected[slot.id]!.memberId })),
    [selected, shift.slots],
  );

  async function submit() {
    if (selections.length === 0) {
      onError("请先选择实际到场人员");
      return;
    }
    setSubmitting(true);
    try {
      const results = await window.checkinApi.checkIn(shift.id, selections);
      const newCount = results.filter((result) => !result.alreadyExisted).length;
      await onSuccess(`已签到 ${newCount || selections.length} 人 · 本班每人计 ${hoursLabel(shift.paidMinutes)} 小时`);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={`day-shift-row ${phase} ${completed === shift.slots.length ? "complete" : ""}`}>
      <div className="day-shift-time">
        <strong>{shift.startTime}</strong>
        <span>{shift.endTime}</span>
        <small>{hoursLabel(shift.paidMinutes)}h</small>
      </div>
      <div className="day-shift-content">
        <div className="day-shift-header">
          <div>
            <div className="day-shift-title-row">
              <h2>{shift.label}</h2>
              <span className={`calendar-state ${phaseTone}`}><i />{phaseLabel}</span>
            </div>
            <p className="shift-responsible">负责人：<strong>{responsible}</strong></p>
          </div>
          <div className="day-shift-stats">
            {phase === "current" && <div className="shift-countdown"><span>距结束</span><strong>{countdownTo(shift.endTime, now)}</strong></div>}
            <div className="shift-progress"><strong>{completed}/{shift.slots.length}</strong><span>已签到</span></div>
          </div>
        </div>

        <div className="slot-list">
          {shift.slots.map((slot) => {
            const state = selected[slot.id] ?? { enabled: false, memberId: "" };
            const already = Boolean(slot.attendanceId);
            return (
              <div className={`slot-row ${already ? "done" : ""}`} key={slot.id}>
                {shift.slots.length > 1 && (
                  <input
                    type="checkbox"
                    aria-label={`选择席位 ${slot.position}`}
                    checked={already || state.enabled}
                    disabled={already || phase !== "current"}
                    onChange={(event) =>
                      setSelected((current) => ({ ...current, [slot.id]: { ...state, enabled: event.target.checked } }))
                    }
                  />
                )}
                <div className="slot-label">
                  <span>席位 {slot.position}</span>
                  <small>原排班：{slot.scheduledMemberName ?? "空位"}</small>
                </div>
                {already ? (
                  <div className="signed-person">
                    <strong>{slot.actualMemberName}</strong>
                    <small>{slot.punchTime ? new Date(slot.punchTime).toLocaleTimeString("zh-CN", { hour12: false }) : "已签到"}</small>
                  </div>
                ) : phase === "current" ? (
                  <select
                    aria-label={`席位 ${slot.position} 实际到场人员`}
                    value={state.memberId}
                    onChange={(event) => setSelected((current) => ({ ...current, [slot.id]: { ...state, memberId: event.target.value } }))}
                  >
                    <option value="">选择实际人员</option>
                    {members.map((member) => (
                      <option key={member.id} value={member.id}>{member.name}</option>
                    ))}
                  </select>
                ) : (
                  <div className={`shift-slot-state ${phase}`}>{phase === "upcoming" ? "等待开班" : "未到岗"}</div>
                )}
              </div>
            );
          })}
        </div>

        <div className="day-shift-action">
          <button className="primary-button" disabled={phase !== "current" || submitting || selections.length === 0} onClick={() => void submit()}>
            {phase === "upcoming" ? "尚未到签到时间" : phase === "ended" ? "本班次已结束" : submitting ? "正在保存…" : shift.slots.length > 1 ? `为所选 ${selections.length} 人签到` : "签到"}
          </button>
        </div>
      </div>
    </section>
  );
}

function countdownTo(endTime: string, now: Date): string {
  const [endHour = 0, endMinute = 0] = endTime.split(":").map(Number);
  const remaining = Math.max(0, (endHour * 60 * 60 + endMinute * 60) - (now.getHours() * 60 * 60 + now.getMinutes() * 60 + now.getSeconds()));
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}
