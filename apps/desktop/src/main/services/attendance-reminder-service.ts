import type {
  AttendanceReminderPayload,
  ShiftSlotView,
  ShiftView,
} from "../../shared/contracts";
import type { DatabaseStore } from "../database";
import type { AttendanceService } from "./attendance-service";

const SETTINGS_KEY = "attendance_reminders";
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type ReminderState = {
  version: 1;
  reminded: Record<string, string>;
};

export interface AttendanceReminderDeliveryTarget {
  send(payload: AttendanceReminderPayload): void;
  isForeground(): boolean;
  showSystemNotification(
    title: string,
    body: string,
    onClick: () => void,
  ): void;
  flashTaskbar(): void;
  restoreWindow(): void;
}

export function deliverAttendanceReminder(
  payload: AttendanceReminderPayload,
  target: AttendanceReminderDeliveryTarget,
): void {
  target.send(payload);
  if (target.isForeground()) return;
  const shiftSummary = payload.shifts
    .map((shift) => `${shift.label}：${shift.pendingNames.join("、")}`)
    .join("；");
  target.showSystemNotification(
    `${payload.totalPending} 人尚未签到`,
    shiftSummary,
    () => target.restoreWindow(),
  );
  target.flashTaskbar();
}

function shiftStart(shift: ShiftView): Date {
  const [year, month, day] = shift.date.split("-").map(Number);
  const [hour, minute] = shift.startTime.split(":").map(Number);
  return new Date(year!, month! - 1, day!, hour!, minute!, 0, 0);
}

function pendingName(slot: ShiftSlotView): string {
  return (
    slot.leave?.replacementMemberName ??
    slot.scheduledMemberName ??
    "待安排人员"
  );
}

export class AttendanceReminderService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private initialTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: DatabaseStore,
    private readonly attendance: AttendanceService,
    private readonly emit: (payload: AttendanceReminderPayload) => void,
    private readonly intervalMs = 30_000,
  ) {}

  start(): void {
    if (this.timer || this.initialTimer) return;
    this.initialTimer = setTimeout(() => {
      this.initialTimer = undefined;
      void this.check();
    }, Math.min(1_000, this.intervalMs));
    this.timer = setInterval(() => void this.check(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.timer = undefined;
    this.initialTimer = undefined;
  }

  check(now = new Date()): AttendanceReminderPayload | null {
    const state = this.readState();
    const cutoff = now.getTime() - RETENTION_MS;
    const reminded = Object.fromEntries(
      Object.entries(state.reminded).filter(
        ([, value]) => new Date(value).getTime() >= cutoff,
      ),
    );
    const due = this.attendance
      .getCurrentAndNext(now.toISOString())
      .current.map((shift) => ({
        shift,
        pending: shift.slots.filter(
          (slot) =>
            !slot.attendanceId &&
            !(slot.leave && !slot.leave.replacementMemberId),
        ),
      }))
      .filter(
        ({ shift, pending }) =>
          pending.length > 0 &&
          now.getTime() >= shiftStart(shift).getTime() + 15 * 60 * 1000 &&
          !reminded[shift.id],
      );
    const stateWasPruned =
      Object.keys(reminded).length !== Object.keys(state.reminded).length;
    if (!due.length) {
      if (stateWasPruned) this.writeState({ version: 1, reminded }, now);
      return null;
    }
    for (const { shift } of due) reminded[shift.id] = now.toISOString();
    this.writeState({ version: 1, reminded }, now);
    const payload: AttendanceReminderPayload = {
      triggeredAt: now.toISOString(),
      totalPending: due.reduce((count, item) => count + item.pending.length, 0),
      shifts: due.map(({ shift, pending }) => ({
        id: shift.id,
        date: shift.date,
        label: shift.workType === "overtime" ? "加班" : shift.label,
        startTime: shift.startTime,
        endTime: shift.endTime,
        pendingNames: pending.map(pendingName),
      })),
    };
    this.emit(payload);
    return payload;
  }

  private readState(): ReminderState {
    const row = this.store
      .prepare("SELECT value_json FROM settings WHERE key=?")
      .get(SETTINGS_KEY) as { value_json: string } | undefined;
    if (!row) return { version: 1, reminded: {} };
    try {
      const value = JSON.parse(row.value_json) as Partial<ReminderState>;
      return {
        version: 1,
        reminded:
          value.reminded && typeof value.reminded === "object"
            ? value.reminded
            : {},
      };
    } catch {
      return { version: 1, reminded: {} };
    }
  }

  private writeState(state: ReminderState, now: Date): void {
    this.store
      .prepare(`
        INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE
        SET value_json=excluded.value_json,updated_at=excluded.updated_at
      `)
      .run(SETTINGS_KEY, JSON.stringify(state), now.toISOString());
  }
}
