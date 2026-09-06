import type { AttendanceMode, LateStatus } from "../shared/contracts";

export function parseTimeToMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`无效时间：${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`无效时间：${value}`);
  return hour * 60 + minute;
}

export function paidMinutesBetween(startTime: string, endTime: string): number {
  const minutes = parseTimeToMinutes(endTime) - parseTimeToMinutes(startTime);
  if (minutes <= 0) throw new Error("首版不支持跨午夜或非正时长班次");
  return minutes;
}

export function isWithinShift(localTime: string, startTime: string, endTime: string): boolean {
  const current = parseTimeToMinutes(localTime);
  return current >= parseTimeToMinutes(startTime) && current < parseTimeToMinutes(endTime);
}

export function lateStatusFor(
  localTime: string | null,
  startTime: string,
  mode: AttendanceMode,
  thresholdMinutes: number,
  source: "realtime" | "manual",
): LateStatus {
  if (source === "manual" && !localTime) return "manual_unjudged";
  if (mode === "lenient") return "normal";
  const current = parseTimeToMinutes(localTime ?? startTime);
  return current > parseTimeToMinutes(startTime) + thresholdMinutes ? "late" : "normal";
}

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatLocalTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatLocalDateTimeKey(date: Date): string {
  return `${formatLocalDate(date)}T${formatLocalTime(date)}`;
}

export function dateFromOptionalIso(iso?: string): Date {
  const value = iso ? new Date(iso) : new Date();
  if (Number.isNaN(value.getTime())) throw new Error("无效日期时间");
  return value;
}

export function hoursLabel(minutes: number): string {
  return (minutes / 60).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

export function addDays(dateString: string, days: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`无效日期：${dateString}`);
  const date = new Date(year, month - 1, day + days);
  return formatLocalDate(date);
}

export function monthBounds(year: number, month: number): { startDate: string; endDate: string } {
  return {
    startDate: formatLocalDate(new Date(year, month - 1, 1)),
    endDate: formatLocalDate(new Date(year, month, 0)),
  };
}

export function payrollPeriod(year: number, month: number): { startDate: string; endDate: string } {
  return {
    startDate: formatLocalDate(new Date(year, month - 2, 26)),
    endDate: formatLocalDate(new Date(year, month - 1, 25)),
  };
}

