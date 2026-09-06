import { randomUUID } from "node:crypto";
import type {
  AttendanceRecordView,
  CheckInResult,
  CheckInSelection,
  ManualAttendanceInput,
  RecordFilters,
  ShiftKind,
  ShiftSlotView,
  ShiftView,
} from "../../shared/contracts";
import { dateFromOptionalIso, formatLocalDate, formatLocalTime, isWithinShift, lateStatusFor } from "../../domain/time";
import type { DatabaseStore } from "../database";
import type { MemberService } from "./member-service";

type ShiftRow = {
  id: string;
  date: string;
  kind: ShiftKind;
  label: string;
  start_time: string;
  end_time: string;
  paid_minutes: number;
  attendance_mode: "lenient" | "late_mark";
  late_threshold_minutes: number;
};

type SlotRow = {
  id: string;
  position: number;
  scheduled_member_id: string | null;
  scheduled_member_name: string | null;
  attendance_id: string | null;
  actual_member_id: string | null;
  actual_member_name: string | null;
  punch_time: string | null;
  late_status: ShiftSlotView["lateStatus"];
};

type RecordRow = {
  id: string;
  shift_id: string;
  shift_slot_id: string;
  date: string;
  kind: ShiftKind;
  label: string;
  start_time: string;
  end_time: string;
  scheduled_member_name: string | null;
  actual_member_id: string;
  actual_member_name: string;
  punch_time: string | null;
  entered_at: string;
  paid_minutes: number;
  late_status: AttendanceRecordView["lateStatus"];
  source: AttendanceRecordView["source"];
  status: AttendanceRecordView["status"];
};

const RECORD_SELECT = `
  SELECT ar.id, ar.shift_id, ar.shift_slot_id, s.date, s.kind, s.label, s.start_time, s.end_time,
         scheduled.name AS scheduled_member_name,
         ar.actual_member_id, actual.name AS actual_member_name,
         ar.punch_time, ar.entered_at, ar.paid_minutes, ar.late_status, ar.source, ar.status
  FROM attendance_records ar
  JOIN shifts s ON s.id = ar.shift_id
  JOIN shift_slots ss ON ss.id = ar.shift_slot_id
  LEFT JOIN members scheduled ON scheduled.id = ss.scheduled_member_id
  JOIN members actual ON actual.id = ar.actual_member_id
`;

function mapRecord(row: RecordRow): AttendanceRecordView {
  return {
    id: row.id,
    shiftId: row.shift_id,
    slotId: row.shift_slot_id,
    date: row.date,
    kind: row.kind,
    label: row.label,
    startTime: row.start_time,
    endTime: row.end_time,
    scheduledMemberName: row.scheduled_member_name,
    actualMemberId: row.actual_member_id,
    actualMemberName: row.actual_member_name,
    punchTime: row.punch_time,
    enteredAt: row.entered_at,
    paidMinutes: Number(row.paid_minutes),
    lateStatus: row.late_status,
    source: row.source,
    status: row.status,
  };
}

export class AttendanceService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly members: MemberService,
  ) {}

  getCurrentAndNext(nowIso?: string): { current: ShiftView[]; next: ShiftView[] } {
    const now = dateFromOptionalIso(nowIso);
    const date = formatLocalDate(now);
    const time = formatLocalTime(now);
    const today = this.getShiftsForDate(date);
    const current = today.filter((shift) => isWithinShift(time, shift.startTime, shift.endTime));
    const nextToday = today.filter((shift) => shift.startTime > time).slice(0, 3);
    if (nextToday.length > 0) return { current, next: nextToday };
    const futureRows = this.store
      .prepare("SELECT DISTINCT date FROM shifts WHERE active = 1 AND date > ? ORDER BY date LIMIT 1")
      .get(date) as { date: string } | undefined;
    return { current, next: futureRows ? this.getShiftsForDate(futureRows.date).slice(0, 3) : [] };
  }

  getShiftsForDate(date: string): ShiftView[] {
    const rows = this.store
      .prepare("SELECT * FROM shifts WHERE date = ? AND active = 1 ORDER BY start_time, kind")
      .all(date) as unknown as ShiftRow[];
    return rows.map((row) => this.mapShift(row));
  }

  getShift(id: string): ShiftView | null {
    const row = this.store.prepare("SELECT * FROM shifts WHERE id = ? AND active = 1").get(id) as ShiftRow | undefined;
    return row ? this.mapShift(row) : null;
  }

  checkIn(shiftId: string, selections: CheckInSelection[], nowIso?: string): CheckInResult[] {
    if (selections.length === 0) throw new Error("请至少选择一名实际到场人员");
    const shift = this.getShift(shiftId);
    if (!shift) throw new Error("班次不存在或已失效");
    const now = dateFromOptionalIso(nowIso);
    if (formatLocalDate(now) !== shift.date || !isWithinShift(formatLocalTime(now), shift.startTime, shift.endTime)) {
      throw new Error("当前不在该班次的签到时间内");
    }
    const memberIds = selections.map((selection) => selection.memberId);
    if (new Set(memberIds).size !== memberIds.length) throw new Error("同一人在同一班不能占用多个席位");
    const slotIds = new Set(shift.slots.map((slot) => slot.id));
    for (const selection of selections) {
      if (!slotIds.has(selection.slotId)) throw new Error("签到席位不属于当前班次");
      if (!this.members.get(selection.memberId)?.active) throw new Error("所选成员不存在或已停用");
    }

    const punchTime = now.toISOString();
    const enteredAt = new Date().toISOString();
    return this.store.transaction(() =>
      selections.map((selection) => {
        const bySlot = this.store
          .prepare("SELECT id, actual_member_id FROM attendance_records WHERE shift_slot_id = ? AND status = 'active'")
          .get(selection.slotId) as { id: string; actual_member_id: string } | undefined;
        if (bySlot) {
          if (bySlot.actual_member_id !== selection.memberId) throw new Error("该席位已经由其他成员签到");
          return { record: this.getRecord(bySlot.id), alreadyExisted: true };
        }
        const duplicateMember = this.store
          .prepare("SELECT id FROM attendance_records WHERE shift_id = ? AND actual_member_id = ? AND status = 'active'")
          .get(shiftId, selection.memberId) as { id: string } | undefined;
        if (duplicateMember) throw new Error("同一成员已经在本班其他席位签到");

        const id = randomUUID();
        const lateStatus = lateStatusFor(
          formatLocalTime(now),
          shift.startTime,
          shift.attendanceMode,
          shift.lateThresholdMinutes,
          "realtime",
        );
        this.store
          .prepare(`
            INSERT INTO attendance_records(
              id, shift_id, shift_slot_id, actual_member_id, punch_time, entered_at, paid_minutes,
              late_status, source, status, attendance_mode, late_threshold_minutes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'realtime', 'active', ?, ?, ?, ?)
          `)
          .run(
            id,
            shiftId,
            selection.slotId,
            selection.memberId,
            punchTime,
            enteredAt,
            shift.paidMinutes,
            lateStatus,
            shift.attendanceMode,
            shift.lateThresholdMinutes,
            enteredAt,
            enteredAt,
          );
        return { record: this.getRecord(id), alreadyExisted: false };
      }),
    );
  }

  listRecords(filters: RecordFilters = {}): AttendanceRecordView[] {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (!filters.includeRevoked) conditions.push("ar.status = 'active'");
    if (filters.startDate) {
      conditions.push("s.date >= ?");
      parameters.push(filters.startDate);
    }
    if (filters.endDate) {
      conditions.push("s.date <= ?");
      parameters.push(filters.endDate);
    }
    if (filters.memberId) {
      conditions.push("ar.actual_member_id = ?");
      parameters.push(filters.memberId);
    }
    if (filters.kind && filters.kind !== "all") {
      conditions.push("s.kind = ?");
      parameters.push(filters.kind);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.store
      .prepare(`${RECORD_SELECT} ${where} ORDER BY s.date DESC, s.start_time DESC, ar.entered_at DESC`)
      .all(...parameters) as unknown as RecordRow[];
    return rows.map(mapRecord);
  }

  getRecord(id: string): AttendanceRecordView {
    const row = this.store.prepare(`${RECORD_SELECT} WHERE ar.id = ?`).get(id) as RecordRow | undefined;
    if (!row) throw new Error("签到记录不存在");
    return mapRecord(row);
  }

  correctMember(recordId: string, memberId: string): AttendanceRecordView {
    const record = this.getRecord(recordId);
    if (record.status !== "active") throw new Error("只能更正有效签到记录");
    if (!this.members.get(memberId)?.active) throw new Error("目标成员不存在或已停用");
    if (record.actualMemberId === memberId) return record;
    const duplicate = this.store
      .prepare("SELECT id FROM attendance_records WHERE shift_id = ? AND actual_member_id = ? AND status = 'active' AND id <> ?")
      .get(record.shiftId, memberId, recordId) as { id: string } | undefined;
    if (duplicate) throw new Error("目标成员已经在该班次签到");
    const changedAt = new Date().toISOString();
    this.store.transaction(() => {
      this.store.prepare("UPDATE attendance_records SET actual_member_id = ?, updated_at = ? WHERE id = ?").run(memberId, changedAt, recordId);
      this.logChange(recordId, "correct_member", { actualMemberId: record.actualMemberId }, { actualMemberId: memberId }, changedAt);
    });
    return this.getRecord(recordId);
  }

  revoke(recordId: string): void {
    const record = this.getRecord(recordId);
    if (record.status === "revoked") return;
    const changedAt = new Date().toISOString();
    this.store.transaction(() => {
      this.store.prepare("UPDATE attendance_records SET status = 'revoked', updated_at = ? WHERE id = ?").run(changedAt, recordId);
      this.logChange(recordId, "revoke", { status: "active" }, { status: "revoked" }, changedAt);
    });
  }

  restore(recordId: string): AttendanceRecordView {
    const record = this.getRecord(recordId);
    if (record.status === "active") return record;
    const slotConflict = this.store
      .prepare("SELECT id FROM attendance_records WHERE shift_slot_id = ? AND status = 'active'")
      .get(record.slotId) as { id: string } | undefined;
    const memberConflict = this.store
      .prepare("SELECT id FROM attendance_records WHERE shift_id = ? AND actual_member_id = ? AND status = 'active'")
      .get(record.shiftId, record.actualMemberId) as { id: string } | undefined;
    if (slotConflict || memberConflict) throw new Error("该席位或成员已有有效签到，不能恢复");
    const changedAt = new Date().toISOString();
    this.store.transaction(() => {
      this.store.prepare("UPDATE attendance_records SET status = 'active', updated_at = ? WHERE id = ?").run(changedAt, recordId);
      this.logChange(recordId, "restore", { status: "revoked" }, { status: "active" }, changedAt);
    });
    return this.getRecord(recordId);
  }

  addManual(input: ManualAttendanceInput): AttendanceRecordView {
    const slot = this.store
      .prepare(`
        SELECT ss.id, ss.shift_id, s.date, s.start_time, s.paid_minutes, s.attendance_mode, s.late_threshold_minutes
        FROM shift_slots ss JOIN shifts s ON s.id = ss.shift_id
        WHERE ss.id = ? AND s.active = 1 AND ss.is_vacant = 0
      `)
      .get(input.slotId) as
      | {
          id: string;
          shift_id: string;
          date: string;
          start_time: string;
          paid_minutes: number;
          attendance_mode: "lenient" | "late_mark";
          late_threshold_minutes: number;
        }
      | undefined;
    if (!slot) throw new Error("补记席位不存在或已失效");
    if (!this.members.get(input.memberId)?.active) throw new Error("所选成员不存在或已停用");
    const punchDate = input.historicalPunchTime ? dateFromOptionalIso(input.historicalPunchTime) : null;
    const punchTime = punchDate?.toISOString() ?? null;
    const enteredAt = new Date().toISOString();
    const lateStatus = lateStatusFor(
      punchDate ? formatLocalTime(punchDate) : null,
      slot.start_time,
      slot.attendance_mode,
      slot.late_threshold_minutes,
      "manual",
    );
    const id = randomUUID();
    this.store.transaction(() => {
      const occupied = this.store
        .prepare("SELECT id FROM attendance_records WHERE shift_slot_id = ? AND status = 'active'")
        .get(input.slotId) as { id: string } | undefined;
      if (occupied) throw new Error("该席位已有有效签到");
      const duplicate = this.store
        .prepare("SELECT id FROM attendance_records WHERE shift_id = ? AND actual_member_id = ? AND status = 'active'")
        .get(slot.shift_id, input.memberId) as { id: string } | undefined;
      if (duplicate) throw new Error("同一成员已经在该班次签到");
      this.store
        .prepare(`
          INSERT INTO attendance_records(
            id, shift_id, shift_slot_id, actual_member_id, punch_time, entered_at, paid_minutes,
            late_status, source, status, attendance_mode, late_threshold_minutes, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'active', ?, ?, ?, ?)
        `)
        .run(
          id,
          slot.shift_id,
          input.slotId,
          input.memberId,
          punchTime,
          enteredAt,
          slot.paid_minutes,
          lateStatus,
          slot.attendance_mode,
          slot.late_threshold_minutes,
          enteredAt,
          enteredAt,
        );
    });
    return this.getRecord(id);
  }

  private mapShift(row: ShiftRow): ShiftView {
    const slots = this.store
      .prepare(`
        SELECT ss.id, ss.position, ss.scheduled_member_id, scheduled.name AS scheduled_member_name,
               ar.id AS attendance_id, ar.actual_member_id, actual.name AS actual_member_name,
               ar.punch_time, ar.late_status
        FROM shift_slots ss
        LEFT JOIN members scheduled ON scheduled.id = ss.scheduled_member_id
        LEFT JOIN attendance_records ar ON ar.shift_slot_id = ss.id AND ar.status = 'active'
        LEFT JOIN members actual ON actual.id = ar.actual_member_id
        WHERE ss.shift_id = ? AND ss.is_vacant = 0 ORDER BY ss.position
      `)
      .all(row.id) as unknown as SlotRow[];
    return {
      id: row.id,
      date: row.date,
      kind: row.kind,
      label: row.label,
      startTime: row.start_time,
      endTime: row.end_time,
      paidMinutes: Number(row.paid_minutes),
      attendanceMode: row.attendance_mode,
      lateThresholdMinutes: Number(row.late_threshold_minutes),
      slots: slots.map((slot) => ({
        id: slot.id,
        position: Number(slot.position),
        scheduledMemberId: slot.scheduled_member_id,
        scheduledMemberName: slot.scheduled_member_name,
        attendanceId: slot.attendance_id,
        actualMemberId: slot.actual_member_id,
        actualMemberName: slot.actual_member_name,
        punchTime: slot.punch_time,
        lateStatus: slot.late_status,
      })),
    };
  }

  private logChange(
    attendanceId: string,
    type: "correct_member" | "revoke" | "restore" | "set_punch_time",
    before: unknown,
    after: unknown,
    changedAt: string,
  ): void {
    this.store
      .prepare(`
        INSERT INTO attendance_changes(id, attendance_id, change_type, before_json, after_json, source, changed_at)
        VALUES (?, ?, ?, ?, ?, 'local_ui', ?)
      `)
      .run(randomUUID(), attendanceId, type, JSON.stringify(before), JSON.stringify(after), changedAt);
  }
}
