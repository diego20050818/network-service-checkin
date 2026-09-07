import { randomUUID } from "node:crypto";
import { formatLocalDateTimeKey, paidMinutesBetween } from "../../domain/time";
import type {
  LeaveInfo,
  LeaveInput,
  LeaveRecordView,
  OvertimeEntryView,
  OvertimeInput,
  ShiftView,
} from "../../shared/contracts";
import type { DatabaseStore } from "../database";
import type { AttendanceService } from "./attendance-service";
import type { MemberService } from "./member-service";

type LeaveRow = {
  id: string;
  shift_id: string;
  shift_slot_id: string;
  member_id: string;
  member_name: string;
  replacement_member_id: string | null;
  replacement_member_name: string | null;
  reason: string;
  status: "active" | "cancelled";
  created_at: string;
  updated_at: string;
  date: string;
  kind: LeaveRecordView["kind"];
  label: string;
  start_time: string;
  end_time: string;
};

type SlotTarget = {
  id: string;
  shift_id: string;
  scheduled_member_id: string | null;
  date: string;
  kind: LeaveRecordView["kind"];
  start_time: string;
  end_time: string;
  work_type: "regular" | "overtime";
};

type OvertimeRow = {
  shift_id: string;
  slot_id: string;
  member_id: string;
  member_name: string;
  date: string;
  start_time: string;
  end_time: string;
  paid_minutes: number;
  note: string;
  is_vacant: number;
  attendance_id: string | null;
};

const LEAVE_SELECT = `
  SELECT lr.id, lr.shift_slot_id, lr.member_id, member.name AS member_name,
         lr.replacement_member_id, replacement.name AS replacement_member_name,
         lr.reason, lr.status, lr.created_at, lr.updated_at,
         s.id AS shift_id, s.date, s.kind, s.label, s.start_time, s.end_time
  FROM leave_records lr
  JOIN shift_slots ss ON ss.id = lr.shift_slot_id
  JOIN shifts s ON s.id = ss.shift_id
  JOIN members member ON member.id = lr.member_id
  LEFT JOIN members replacement ON replacement.id = lr.replacement_member_id
`;

function mapLeave(row: LeaveRow): LeaveRecordView {
  return {
    id: row.id,
    shiftId: row.shift_id,
    slotId: row.shift_slot_id,
    memberId: row.member_id,
    memberName: row.member_name,
    replacementMemberId: row.replacement_member_id,
    replacementMemberName: row.replacement_member_name,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    date: row.date,
    kind: row.kind,
    label: row.label,
    startTime: row.start_time,
    endTime: row.end_time,
  };
}

function mapLeaveInfo(row: LeaveRow): LeaveInfo {
  const value = mapLeave(row);
  return {
    id: value.id,
    memberId: value.memberId,
    memberName: value.memberName,
    replacementMemberId: value.replacementMemberId,
    replacementMemberName: value.replacementMemberName,
    reason: value.reason,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapOvertime(row: OvertimeRow): OvertimeEntryView {
  return {
    shiftId: row.shift_id,
    slotId: row.slot_id,
    memberId: row.member_id,
    memberName: row.member_name,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    paidMinutes: Number(row.paid_minutes),
    note: row.note,
    attendanceId: row.attendance_id,
    status: row.is_vacant === 1 ? "cancelled" : row.attendance_id ? "completed" : "planned",
  };
}

export class AdjustmentService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly members: MemberService,
    private readonly attendance: AttendanceService,
  ) {}

  listLeaves(filters: { startDate: string; endDate: string; includeCancelled?: boolean }): LeaveRecordView[] {
    const status = filters.includeCancelled ? "" : "AND lr.status = 'active'";
    const rows = this.store.prepare(`${LEAVE_SELECT}
      WHERE s.date BETWEEN ? AND ? ${status}
      ORDER BY s.date DESC, s.start_time DESC, lr.created_at DESC
    `).all(filters.startDate, filters.endDate) as unknown as LeaveRow[];
    return rows.map(mapLeave);
  }

  getActiveLeaveForSlot(slotId: string): LeaveInfo | null {
    const row = this.store.prepare(`${LEAVE_SELECT} WHERE lr.shift_slot_id = ? AND lr.status = 'active'`).get(slotId) as LeaveRow | undefined;
    return row ? mapLeaveInfo(row) : null;
  }

  createLeave(input: LeaveInput, now = new Date()): LeaveRecordView {
    const slot = this.leaveTarget(input.slotId);
    if (!slot.scheduled_member_id) throw new Error("只有已安排成员的席位可以请假");
    if (this.hasActiveAttendance(slot.id)) throw new Error("该席位已有签到，请先撤销签到");
    if (this.getActiveLeaveForSlot(slot.id)) throw new Error("该席位已经登记请假");
    this.validateReplacement(slot, input.replacementMemberId ?? null, now);
    const id = randomUUID();
    const changedAt = new Date().toISOString();
    this.store.prepare(`
      INSERT INTO leave_records(
        id, shift_slot_id, member_id, replacement_member_id, reason, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(id, slot.id, slot.scheduled_member_id, input.replacementMemberId ?? null, input.reason?.trim() ?? "", changedAt, changedAt);
    return this.getLeave(id);
  }

  updateLeave(leaveId: string, input: Omit<LeaveInput, "slotId">, now = new Date()): LeaveRecordView {
    const leave = this.getLeave(leaveId);
    if (leave.status !== "active") throw new Error("只能修改有效请假");
    if (this.hasActiveAttendance(leave.slotId)) throw new Error("代班人已签到，请先撤销签到");
    const slot = this.leaveTarget(leave.slotId);
    this.validateReplacement(slot, input.replacementMemberId ?? null, now);
    this.store.prepare(`
      UPDATE leave_records SET replacement_member_id = ?, reason = ?, updated_at = ? WHERE id = ?
    `).run(input.replacementMemberId ?? null, input.reason?.trim() ?? "", new Date().toISOString(), leaveId);
    return this.getLeave(leaveId);
  }

  cancelLeave(leaveId: string): void {
    const leave = this.getLeave(leaveId);
    if (leave.status === "cancelled") return;
    if (this.hasActiveAttendance(leave.slotId)) throw new Error("代班人已签到，请先撤销签到");
    this.store.prepare("UPDATE leave_records SET status = 'cancelled', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), leaveId);
  }

  addShiftStaff(input: { shiftId: string; memberId: string }): ShiftView {
    const shift = this.store.prepare("SELECT id FROM shifts WHERE id = ? AND active = 1 AND work_type = 'regular'")
      .get(input.shiftId) as { id: string } | undefined;
    if (!shift) throw new Error("只能为有效正式班次添加办公人员");
    if (!this.members.get(input.memberId)?.active) throw new Error("所选成员不存在或已停用");
    const duplicate = this.store.prepare(`
      SELECT ss.id FROM shift_slots ss
      LEFT JOIN leave_records lr ON lr.shift_slot_id = ss.id AND lr.status = 'active'
      WHERE ss.shift_id = ? AND ss.is_vacant = 0
        AND (ss.scheduled_member_id = ? OR lr.replacement_member_id = ?)
      LIMIT 1
    `).get(input.shiftId, input.memberId, input.memberId) as { id: string } | undefined;
    if (duplicate) throw new Error("该成员已在本班次中");
    this.store.transaction(() => {
      const row = this.store.prepare("SELECT COALESCE(MAX(position), 0) AS position FROM shift_slots WHERE shift_id = ?")
        .get(input.shiftId) as { position: number };
      this.store.prepare(`
        INSERT INTO shift_slots(
          id, shift_id, position, scheduled_member_id, is_vacant, slot_role, slot_source, slot_note
        ) VALUES (?, ?, ?, ?, 0, 'staff', 'manual', '')
      `).run(randomUUID(), input.shiftId, Number(row.position) + 1, input.memberId);
      this.syncRequiredSlots(input.shiftId);
    });
    return this.attendance.getShift(input.shiftId)!;
  }

  removeShiftStaff(slotId: string): void {
    const slot = this.store.prepare(`
      SELECT ss.id, ss.shift_id FROM shift_slots ss
      JOIN shifts s ON s.id = ss.shift_id
      WHERE ss.id = ? AND ss.is_vacant = 0 AND ss.slot_role = 'staff'
        AND ss.slot_source = 'manual' AND s.work_type = 'regular'
    `).get(slotId) as { id: string; shift_id: string } | undefined;
    if (!slot) throw new Error("只能移除手工添加的办公人员");
    if (this.hasActiveAttendance(slotId)) throw new Error("该办公人员已有签到，请先撤销签到");
    if (this.getActiveLeaveForSlot(slotId)) throw new Error("该办公人员已有请假，请先撤销请假");
    this.store.transaction(() => {
      this.store.prepare("UPDATE shift_slots SET is_vacant = 1 WHERE id = ?").run(slotId);
      this.syncRequiredSlots(slot.shift_id);
    });
  }

  listOvertime(filters: { startDate: string; endDate: string; includeCancelled?: boolean }): OvertimeEntryView[] {
    const cancelled = filters.includeCancelled ? "" : "AND ss.is_vacant = 0";
    const rows = this.store.prepare(`
      SELECT s.id AS shift_id, ss.id AS slot_id, ss.scheduled_member_id AS member_id,
             m.name AS member_name, s.date, s.start_time, s.end_time, s.paid_minutes,
             ss.slot_note AS note, ss.is_vacant, ar.id AS attendance_id
      FROM shifts s
      JOIN shift_slots ss ON ss.shift_id = s.id
      JOIN members m ON m.id = ss.scheduled_member_id
      LEFT JOIN attendance_records ar ON ar.shift_slot_id = ss.id AND ar.status = 'active'
      WHERE s.work_type = 'overtime' AND s.date BETWEEN ? AND ? ${cancelled}
      ORDER BY s.date DESC, s.start_time DESC, ss.position
    `).all(filters.startDate, filters.endDate) as unknown as OvertimeRow[];
    return rows.map(mapOvertime);
  }

  createOvertime(input: OvertimeInput): OvertimeEntryView {
    const member = this.members.get(input.memberId);
    if (!member?.active) throw new Error("所选成员不存在或已停用");
    const paidMinutes = paidMinutesBetween(input.startTime, input.endTime);
    const importId = this.ensureSystemImport(input.date.slice(0, 7));
    const now = new Date().toISOString();
    let shift = this.store.prepare(`
      SELECT id FROM shifts
      WHERE schedule_import_id = ? AND date = ? AND kind = 'desk'
        AND start_time = ? AND end_time = ? AND work_type = 'overtime'
    `).get(importId, input.date, input.startTime, input.endTime) as { id: string } | undefined;
    let createdSlotId = "";
    this.store.transaction(() => {
      if (!shift) {
        shift = { id: randomUUID() };
        this.store.prepare(`
          INSERT INTO shifts(
            id, schedule_import_id, date, kind, label, start_time, end_time, paid_minutes,
            required_slots, attendance_mode, late_threshold_minutes, active, created_at, work_type, note
          ) VALUES (?, ?, ?, 'desk', '加班', ?, ?, ?, 1, 'lenient', 0, 1, ?, 'overtime', '')
        `).run(shift.id, importId, input.date, input.startTime, input.endTime, paidMinutes, now);
      } else {
        this.store.prepare("UPDATE shifts SET active = 1 WHERE id = ?").run(shift.id);
      }
      const duplicate = this.store.prepare(`
        SELECT id FROM shift_slots
        WHERE shift_id = ? AND scheduled_member_id = ? AND is_vacant = 0
      `).get(shift.id, input.memberId) as { id: string } | undefined;
      if (duplicate) throw new Error("该成员已有相同时段的加班安排");
      const row = this.store.prepare("SELECT COALESCE(MAX(position), 0) AS position FROM shift_slots WHERE shift_id = ?")
        .get(shift.id) as { position: number };
      createdSlotId = randomUUID();
      this.store.prepare(`
        INSERT INTO shift_slots(
          id, shift_id, position, scheduled_member_id, is_vacant, slot_role, slot_source, slot_note
        ) VALUES (?, ?, ?, ?, 0, 'overtime', 'manual', ?)
      `).run(createdSlotId, shift.id, Number(row.position) + 1, input.memberId, input.note?.trim() ?? "");
      this.syncRequiredSlots(shift.id);
    });
    return this.getOvertimeEntry(shift!.id, createdSlotId);
  }

  cancelOvertime(slotId: string): void {
    const row = this.store.prepare(`
      SELECT ss.shift_id FROM shift_slots ss JOIN shifts s ON s.id = ss.shift_id
      WHERE ss.id = ? AND ss.is_vacant = 0 AND s.work_type = 'overtime'
    `).get(slotId) as { shift_id: string } | undefined;
    if (!row) throw new Error("加班安排不存在或已取消");
    if (this.hasActiveAttendance(slotId)) throw new Error("该加班已有签到，请先撤销签到");
    this.store.transaction(() => {
      this.store.prepare("UPDATE shift_slots SET is_vacant = 1 WHERE id = ?").run(slotId);
      this.syncRequiredSlots(row.shift_id);
      const remaining = this.store.prepare("SELECT COUNT(*) AS count FROM shift_slots WHERE shift_id = ? AND is_vacant = 0")
        .get(row.shift_id) as { count: number };
      if (Number(remaining.count) === 0) this.store.prepare("UPDATE shifts SET active = 0 WHERE id = ?").run(row.shift_id);
    });
  }

  private getLeave(id: string): LeaveRecordView {
    const row = this.store.prepare(`${LEAVE_SELECT} WHERE lr.id = ?`).get(id) as LeaveRow | undefined;
    if (!row) throw new Error("请假记录不存在");
    return mapLeave(row);
  }

  private leaveTarget(slotId: string): SlotTarget {
    const row = this.store.prepare(`
      SELECT ss.id, ss.shift_id, ss.scheduled_member_id, s.date, s.kind, s.start_time, s.end_time, s.work_type
      FROM shift_slots ss JOIN shifts s ON s.id = ss.shift_id
      WHERE ss.id = ? AND ss.is_vacant = 0 AND s.active = 1 AND s.work_type = 'regular'
    `).get(slotId) as SlotTarget | undefined;
    if (!row) throw new Error("只能为有效正式班次登记请假");
    return row;
  }

  private validateReplacement(slot: SlotTarget, memberId: string | null, now: Date): void {
    if (!memberId) return;
    if (`${slot.date}T${slot.end_time}` <= formatLocalDateTimeKey(now)) throw new Error("已结束班次不能再分配代班人");
    if (memberId === slot.scheduled_member_id) throw new Error("代班人不能是原排班成员");
    if (!this.members.get(memberId)?.active) throw new Error("代班成员不存在或已停用");
    const conflict = this.store.prepare(`
      SELECT ss.id FROM shift_slots ss
      LEFT JOIN leave_records lr ON lr.shift_slot_id = ss.id AND lr.status = 'active'
      WHERE ss.shift_id = ? AND ss.is_vacant = 0 AND ss.id <> ?
        AND (ss.scheduled_member_id = ? OR lr.replacement_member_id = ?)
      LIMIT 1
    `).get(slot.shift_id, slot.id, memberId, memberId) as { id: string } | undefined;
    if (conflict) throw new Error("代班成员已在本班次中");
  }

  private hasActiveAttendance(slotId: string): boolean {
    return Boolean(this.store.prepare("SELECT id FROM attendance_records WHERE shift_slot_id = ? AND status = 'active'").get(slotId));
  }

  private ensureSystemImport(month: string): string {
    const existing = this.store.prepare("SELECT id FROM schedule_imports WHERE source_type = 'system' AND month = ?")
      .get(month) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    this.store.prepare(`
      INSERT INTO schedule_imports(
        id, source_name, source_path, source_sha256, month, effective_date, imported_at,
        warnings_json, active, source_type
      ) VALUES (?, '系统加班安排', '', ?, ?, ?, ?, '[]', 1, 'system')
    `).run(id, `system-overtime-${month}`, month, `${month}-01`, new Date().toISOString());
    return id;
  }

  private syncRequiredSlots(shiftId: string): void {
    this.store.prepare(`
      UPDATE shifts SET required_slots = MAX(1, (
        SELECT COUNT(*) FROM shift_slots WHERE shift_id = ? AND is_vacant = 0
      )) WHERE id = ?
    `).run(shiftId, shiftId);
  }

  private getOvertimeEntry(shiftId: string, slotId: string): OvertimeEntryView {
    const row = this.store.prepare(`
      SELECT s.id AS shift_id, ss.id AS slot_id, ss.scheduled_member_id AS member_id,
             m.name AS member_name, s.date, s.start_time, s.end_time, s.paid_minutes,
             ss.slot_note AS note, ss.is_vacant, ar.id AS attendance_id
      FROM shifts s JOIN shift_slots ss ON ss.shift_id = s.id
      JOIN members m ON m.id = ss.scheduled_member_id
      LEFT JOIN attendance_records ar ON ar.shift_slot_id = ss.id AND ar.status = 'active'
      WHERE s.id = ? AND ss.id = ? AND s.work_type = 'overtime'
    `).get(shiftId, slotId) as OvertimeRow | undefined;
    if (!row) throw new Error("加班安排保存失败");
    return mapOvertime(row);
  }
}
