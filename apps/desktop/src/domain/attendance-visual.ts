import type { ShiftSlotView, ShiftView } from "../shared/contracts";
import { formatLocalDateTimeKey } from "./time";

export type AttendanceSlotVisualState =
  | "arrived"
  | "absent"
  | "upcoming"
  | "leave";
export type AttendanceShiftVisualState =
  | "upcoming"
  | "complete"
  | "attention"
  | "leave";
export type AttendanceShiftPhase = "upcoming" | "current" | "ended";

export const ATTENDANCE_STATE_MARK: Record<AttendanceSlotVisualState, string> = {
  arrived: "✓",
  absent: "×",
  upcoming: "○",
  leave: "—",
};

export const ATTENDANCE_STATE_LABEL: Record<AttendanceSlotVisualState, string> = {
  arrived: "已签到",
  absent: "未签到",
  upcoming: "待开始",
  leave: "请假",
};

export function attendanceSlotVisualState(
  shift: ShiftView,
  slot: ShiftSlotView,
  now: Date,
): AttendanceSlotVisualState {
  if (slot.attendanceId) return "arrived";
  if (slot.leave && !slot.leave.replacementMemberId) return "leave";
  return `${shift.date}T${shift.startTime}` <= formatLocalDateTimeKey(now)
    ? "absent"
    : "upcoming";
}

export function attendanceShiftPhase(
  shift: ShiftView,
  now: Date,
): AttendanceShiftPhase {
  const current = formatLocalDateTimeKey(now);
  if (current < `${shift.date}T${shift.startTime}`) return "upcoming";
  if (current < `${shift.date}T${shift.endTime}`) return "current";
  return "ended";
}

export function selectAttendanceAgendaTarget(
  shifts: ShiftView[],
  now: Date,
): ShiftView | undefined {
  const ordered = [...shifts].sort((left, right) =>
    `${left.date}T${left.startTime}`.localeCompare(
      `${right.date}T${right.startTime}`,
    ),
  );
  return (
    ordered.find((shift) => attendanceShiftPhase(shift, now) === "current") ??
    ordered.find((shift) => attendanceShiftPhase(shift, now) === "upcoming") ??
    ordered.at(-1)
  );
}

export function attendanceShiftVisualState(
  shift: ShiftView,
  now: Date,
): AttendanceShiftVisualState {
  const states = shift.slots.map((slot) =>
    attendanceSlotVisualState(shift, slot, now),
  );
  if (states.length > 0 && states.every((state) => state === "leave"))
    return "leave";
  if (`${shift.date}T${shift.startTime}` > formatLocalDateTimeKey(now))
    return "upcoming";
  if (states.some((state) => state === "absent")) return "attention";
  return "complete";
}

export function attendancePersonLabel(slot: ShiftSlotView): string {
  const scheduled = slot.scheduledMemberName ?? "待安排";
  if (slot.leave && !slot.leave.replacementMemberId)
    return `${scheduled}（请假）`;
  if (slot.actualMemberName && slot.actualMemberName !== scheduled)
    return `${slot.actualMemberName}（替 ${scheduled}）`;
  if (slot.leave?.replacementMemberName)
    return `${slot.leave.replacementMemberName}（代 ${scheduled}）`;
  return slot.actualMemberName ?? scheduled;
}
