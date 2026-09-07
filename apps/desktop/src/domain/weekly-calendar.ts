import type { ShiftSlotView, ShiftView } from "../shared/contracts";
import { formatLocalDate, formatLocalDateTimeKey, parseTimeToMinutes } from "./time";

export type WeeklySlotState = "arrived" | "absent" | "upcoming" | "leave";

export interface PositionedShift {
  shift: ShiftView;
  lane: number;
  laneCount: number;
}

export function mondayOfWeek(date: Date): string {
  const value = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (value.getDay() + 6) % 7;
  value.setDate(value.getDate() - offset);
  return formatLocalDate(value);
}

export function weeklySlotState(shift: ShiftView, slot: ShiftSlotView, now: Date): WeeklySlotState {
  if (slot.attendanceId) return "arrived";
  if (slot.leave && !slot.leave.replacementMemberId) return "leave";
  return `${shift.date}T${shift.startTime}` <= formatLocalDateTimeKey(now) ? "absent" : "upcoming";
}

export function layoutOverlappingShifts(shifts: ShiftView[]): PositionedShift[] {
  const sorted = [...shifts].sort(
    (a, b) => parseTimeToMinutes(a.startTime) - parseTimeToMinutes(b.startTime) || parseTimeToMinutes(a.endTime) - parseTimeToMinutes(b.endTime),
  );
  const active: Array<{ lane: number; end: number }> = [];
  const positioned: Array<{ shift: ShiftView; lane: number }> = [];
  let laneCount = 1;

  for (const shift of sorted) {
    const start = parseTimeToMinutes(shift.startTime);
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index]!.end <= start) active.splice(index, 1);
    }
    const occupied = new Set(active.map((item) => item.lane));
    let lane = 0;
    while (occupied.has(lane)) lane += 1;
    active.push({ lane, end: parseTimeToMinutes(shift.endTime) });
    positioned.push({ shift, lane });
    laneCount = Math.max(laneCount, lane + 1);
  }

  return positioned.map((item) => ({ ...item, laneCount }));
}
