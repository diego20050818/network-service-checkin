import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { addDays, formatLocalDate, parseTimeToMinutes } from "../../domain/time";
import { layoutOverlappingShifts, mondayOfWeek, weeklySlotState, type WeeklySlotState } from "../../domain/weekly-calendar";
import type { ShiftKind, ShiftSlotView, ShiftView } from "../../shared/contracts";
import { errorMessage } from "../App";

const DAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const STATE_LABELS: Record<WeeklySlotState, string> = { arrived: "到岗", absent: "未到岗", upcoming: "未到班" };
const PIXELS_PER_MINUTE = 1;

interface Props {
  kind: ShiftKind | "all";
  memberId: string;
}

export function WeeklySchedule({ kind, memberId }: Props) {
  const calendarScroller = useRef<HTMLDivElement>(null);
  const [weekStart, setWeekStart] = useState(() => mondayOfWeek(new Date()));
  const [shifts, setShifts] = useState<ShiftView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(new Date());
  const dates = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all(dates.map((date) => window.checkinApi.getShiftsForDate(date)))
      .then((days) => {
        if (!cancelled) {
          setShifts(days.flat());
          setError("");
        }
      })
      .catch((cause) => { if (!cancelled) setError(errorMessage(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [dates]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const visibleShifts = useMemo(
    () => shifts.filter((shift) => (kind === "all" || shift.kind === kind) && visibleSlots(shift, memberId).length > 0),
    [kind, memberId, shifts],
  );
  const startMinute = visibleShifts.length
    ? Math.max(0, Math.floor(Math.min(...visibleShifts.map((shift) => parseTimeToMinutes(shift.startTime))) / 60) * 60 - 60)
    : 8 * 60;
  const endMinute = visibleShifts.length
    ? Math.min(24 * 60, Math.ceil(Math.max(...visibleShifts.map((shift) => parseTimeToMinutes(shift.endTime))) / 60) * 60 + 60)
    : 20 * 60;
  const gridHeight = Math.max(360, (endMinute - startMinute) * PIXELS_PER_MINUTE);
  const hourMarks: number[] = [];
  for (let minute = startMinute; minute <= endMinute; minute += 60) hourMarks.push(minute);
  const today = formatLocalDate(now);
  const nowMinute = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

  useEffect(() => {
    if (loading || !dates.includes(today) || !calendarScroller.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (calendarScroller.current) {
        calendarScroller.current.scrollTop = Math.max(0, (nowMinute - startMinute) * PIXELS_PER_MINUTE - 180);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading, startMinute, today, weekStart]);

  return (
    <section className="calendar-surface weekly-schedule">
      <div className="calendar-toolbar">
        <div className="calendar-navigation">
          <button className="calendar-today-button" onClick={() => setWeekStart(mondayOfWeek(new Date()))}>今天</button>
          <div className="calendar-arrow-group">
            <button className="calendar-icon-button" aria-label="上一周" onClick={() => setWeekStart(addDays(weekStart, -7))}>‹</button>
            <button className="calendar-icon-button" aria-label="下一周" onClick={() => setWeekStart(addDays(weekStart, 7))}>›</button>
          </div>
          <div>
            <h2 aria-label="周班表">{dateRangeLabel(dates[0]!, dates[6]!)}</h2>
            <span className="calendar-view-name">周班表</span>
          </div>
        </div>
        <div className="weekly-legend" aria-label="到岗状态图例">
          <span><i className="arrived" />到岗</span><span><i className="absent" />未到岗</span><span><i className="upcoming" />未到班</span>
        </div>
      </div>
      {error && <div className="inline-error compact" role="alert">{error}</div>}
      <div className="week-calendar-scroll" aria-label="周班表日历" ref={calendarScroller}>
        <div className="week-calendar-frame">
          <div className="week-calendar-header">
            <div className="week-zone">时间</div>
            {dates.map((date, index) => <div className={`week-day-heading ${date === today ? "today" : ""}`} key={date}><span>{DAY_NAMES[index]}</span><strong>{Number(date.slice(-2))}</strong></div>)}
          </div>
          <div className="week-calendar-body" style={{ height: gridHeight }}>
            <div className="week-time-axis">
              {hourMarks.map((minute) => <span key={minute} style={{ top: (minute - startMinute) * PIXELS_PER_MINUTE }}>{timeLabel(minute)}</span>)}
            </div>
            <div className="week-hour-lines" aria-hidden="true">
              {hourMarks.map((minute) => <i key={minute} style={{ top: (minute - startMinute) * PIXELS_PER_MINUTE }} />)}
            </div>
            {dates.map((date) => {
              const positioned = layoutOverlappingShifts(visibleShifts.filter((shift) => shift.date === date));
              return <div className={`week-day-column ${date === today ? "today" : ""}`} key={date}>
                {date === today && nowMinute >= startMinute && nowMinute <= endMinute && (
                  <div className="week-now-line" style={{ top: (nowMinute - startMinute) * PIXELS_PER_MINUTE }} aria-hidden="true" />
                )}
                {positioned.map(({ shift, lane, laneCount }) => {
                  const slots = visibleSlots(shift, memberId);
                  const states = slots.map((slot) => weeklySlotState(shift, slot, now));
                  const uniformState = states.every((state) => state === states[0]) ? states[0] : "mixed";
                  const style: CSSProperties = {
                    top: (parseTimeToMinutes(shift.startTime) - startMinute) * PIXELS_PER_MINUTE + 2,
                    height: Math.max(58, (parseTimeToMinutes(shift.endTime) - parseTimeToMinutes(shift.startTime)) * PIXELS_PER_MINUTE - 4),
                    left: `calc(${(lane / laneCount) * 100}% + 3px)`,
                    width: `calc(${100 / laneCount}% - 6px)`,
                  };
                  return <article className={`week-event ${uniformState}`} style={style} key={shift.id} title={`${shift.label} ${shift.startTime}-${shift.endTime}`}>
                    <strong>{shift.label}</strong><time>{shift.startTime}–{shift.endTime}</time>
                    <div className="week-event-people">{slots.map((slot) => <PersonState key={slot.id} shift={shift} slot={slot} now={now} />)}</div>
                  </article>;
                })}
              </div>;
            })}
            {loading && <div className="week-calendar-overlay">正在读取本周班表…</div>}
            {!loading && visibleShifts.length === 0 && <div className="week-calendar-overlay"><div className="calendar-empty"><strong>本周暂无排班</strong><span>可切换周次，或导入正式排班。</span></div></div>}
          </div>
        </div>
      </div>
    </section>
  );
}

function PersonState({ shift, slot, now }: { shift: ShiftView; slot: ShiftSlotView; now: Date }) {
  const state = weeklySlotState(shift, slot, now);
  const scheduled = slot.scheduledMemberName ?? "空位";
  const actual = slot.actualMemberName;
  const name = actual && actual !== scheduled ? `${actual}（替 ${scheduled}）` : actual ?? scheduled;
  return <span className={`week-person ${state}`} title={`${name}：${STATE_LABELS[state]}`}>{name}</span>;
}

function visibleSlots(shift: ShiftView, memberId: string): ShiftSlotView[] {
  if (!memberId) return shift.slots;
  return shift.slots.filter((slot) => slot.scheduledMemberId === memberId || slot.actualMemberId === memberId);
}

function compactDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

function dateRangeLabel(start: string, end: string): string {
  const [startYear] = start.split("-").map(Number);
  const [endYear] = end.split("-").map(Number);
  return startYear === endYear
    ? `${startYear}年 ${compactDate(start).replace(`${startYear}年`, "")} – ${compactDate(end).replace(`${endYear}年`, "")}`
    : `${compactDate(start)} – ${compactDate(end)}`;
}

function timeLabel(minutes: number): string {
  if (minutes === 24 * 60) return "24:00";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:00`;
}
