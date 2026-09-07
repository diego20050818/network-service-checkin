import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ScheduleImportResult, Settings } from "../../shared/contracts";
import { formatLocalDateTimeKey } from "../../domain/time";
import type { DatabaseStore } from "../database";
import type { MemberService } from "./member-service";
import { parseScheduleWorkbook } from "./schedule-parser";

export class ScheduleService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly members: MemberService,
    private readonly scheduleSourceDirectory: string,
  ) {}

  async import(filePath: string, month: string, effectiveDate: string, settings: Settings): Promise<ScheduleImportResult> {
    const file = await readFile(filePath);
    const sourceSha256 = createHash("sha256").update(file).digest("hex");
    const parsed = await parseScheduleWorkbook(filePath, month);
    const existing = this.store
      .prepare("SELECT id, source_name, warnings_json FROM schedule_imports WHERE source_sha256 = ? AND month = ? AND source_type = 'file'")
      .get(sourceSha256, month) as { id: string; source_name: string; warnings_json: string } | undefined;
    if (existing) {
      const createdMembers: string[] = [];
      let addedShiftCount = 0;
      let addedSlotCount = 0;
      const repairedAt = new Date().toISOString();
      this.store.transaction(() => {
        for (const definition of parsed.shifts.filter((shift) => shift.date >= effectiveDate)) {
          const present = this.store
            .prepare(`
              SELECT id FROM shifts
              WHERE schedule_import_id = ? AND date = ? AND kind = ? AND start_time = ? AND end_time = ?
            `)
            .get(existing.id, definition.date, definition.kind, definition.startTime, definition.endTime) as { id: string } | undefined;
          if (present) continue;
          addedSlotCount += this.insertDefinition(existing.id, definition, settings, repairedAt, createdMembers);
          addedShiftCount += 1;
        }
        if (addedShiftCount > 0) {
          this.store.prepare("UPDATE schedule_imports SET warnings_json = ?, imported_at = ? WHERE id = ?")
            .run(JSON.stringify(parsed.warnings), repairedAt, existing.id);
        }
      });
      const counts = this.store
        .prepare(`
          SELECT COUNT(DISTINCT s.id) AS shift_count, COUNT(ss.id) AS slot_count
          FROM shifts s LEFT JOIN shift_slots ss ON ss.shift_id = s.id AND ss.is_vacant = 0
          WHERE s.schedule_import_id = ?
        `)
        .get(existing.id) as { shift_count: number; slot_count: number };
      return {
        importId: existing.id,
        fileName: existing.source_name,
        month,
        effectiveDate,
        shiftCount: Number(counts.shift_count),
        slotCount: Number(counts.slot_count),
        createdMembers: [...new Set(createdMembers)],
        warnings: addedShiftCount > 0 ? parsed.warnings : JSON.parse(existing.warnings_json) as string[],
        duplicate: addedShiftCount === 0,
      };
    }

    const importId = randomUUID();
    const importedAt = new Date().toISOString();
    await mkdir(this.scheduleSourceDirectory, { recursive: true });
    const storedName = `${month}_${importId}_${basename(filePath)}`;
    const storedPath = join(this.scheduleSourceDirectory, storedName);
    await copyFile(filePath, storedPath);

    const createdMembers: string[] = [];
    let slotCount = 0;
    const adjustmentWarnings: string[] = [];
    const nowKey = formatLocalDateTimeKey(new Date());
    this.store.transaction(() => {
      this.store
        .prepare(`
          INSERT INTO schedule_imports(
            id, source_name, source_path, source_sha256, month, effective_date, imported_at, warnings_json, active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        `)
        .run(importId, basename(filePath), storedPath, sourceSha256, month, effectiveDate, importedAt, JSON.stringify(parsed.warnings));

      const adjustedShifts = this.store.prepare(`
        SELECT s.id, s.date, s.kind, s.start_time, s.end_time
        FROM shifts s
        WHERE s.active = 1 AND s.work_type = 'regular'
          AND s.date >= ? AND (s.date || 'T' || s.start_time) > ?
          AND NOT EXISTS (
            SELECT 1 FROM attendance_records ar WHERE ar.shift_id = s.id AND ar.status = 'active'
          )
          AND (
            EXISTS (
              SELECT 1 FROM shift_slots ss
              WHERE ss.shift_id = s.id AND ss.is_vacant = 0 AND ss.slot_source = 'manual'
            ) OR EXISTS (
              SELECT 1 FROM shift_slots ss JOIN leave_records lr ON lr.shift_slot_id = ss.id
              WHERE ss.shift_id = s.id AND lr.status = 'active'
            )
          )
      `).all(effectiveDate, nowKey) as unknown as Array<{ id: string; date: string; kind: string; start_time: string; end_time: string }>;

      this.store
        .prepare(`
          UPDATE shifts
          SET active = 0
          WHERE active = 1
            AND work_type = 'regular'
            AND date >= ?
            AND (date || 'T' || start_time) > ?
            AND NOT EXISTS (
              SELECT 1 FROM attendance_records ar WHERE ar.shift_id = shifts.id AND ar.status = 'active'
            )
        `)
        .run(effectiveDate, nowKey);

      for (const definition of parsed.shifts.filter((shift) => shift.date >= effectiveDate)) {
        slotCount += this.insertDefinition(importId, definition, settings, importedAt, createdMembers);
      }
      for (const oldShift of adjustedShifts) {
        const replacement = this.store.prepare(`
          SELECT id FROM shifts
          WHERE schedule_import_id = ? AND date = ? AND kind = ? AND start_time = ? AND end_time = ?
        `).get(importId, oldShift.date, oldShift.kind, oldShift.start_time, oldShift.end_time) as { id: string } | undefined;
        if (replacement) {
          this.transferAdjustments(oldShift.id, replacement.id, adjustmentWarnings);
        } else {
          this.store.prepare(`
            UPDATE leave_records SET status = 'cancelled', updated_at = ?
            WHERE status = 'active' AND shift_slot_id IN (SELECT id FROM shift_slots WHERE shift_id = ?)
          `).run(importedAt, oldShift.id);
          adjustmentWarnings.push(`${oldShift.date} ${oldShift.start_time}-${oldShift.end_time} 已从新排班移除，相关请假和增员已停用`);
        }
      }
    });

    return {
      importId,
      fileName: basename(filePath),
      month,
      effectiveDate,
      shiftCount: parsed.shifts.filter((shift) => shift.date >= effectiveDate).length,
      slotCount,
      createdMembers: [...new Set(createdMembers)],
      warnings: [...parsed.warnings, ...adjustmentWarnings],
      duplicate: false,
    };
  }

  private insertDefinition(
    importId: string,
    definition: Awaited<ReturnType<typeof parseScheduleWorkbook>>["shifts"][number],
    settings: Settings,
    createdAt: string,
    createdMembers: string[],
  ): number {
    const shiftId = randomUUID();
    this.store
      .prepare(`
        INSERT INTO shifts(
          id, schedule_import_id, date, kind, label, start_time, end_time, paid_minutes,
          required_slots, attendance_mode, late_threshold_minutes, active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `)
      .run(
        shiftId,
        importId,
        definition.date,
        definition.kind,
        definition.label,
        definition.startTime,
        definition.endTime,
        definition.paidMinutes,
        definition.people.length,
        settings.attendanceMode,
        settings.lateThresholdMinutes,
        createdAt,
      );
    definition.people.forEach((name, index) => {
      const ensured = this.members.ensureMinimal(name!);
      if (ensured.created) createdMembers.push(ensured.member.name);
      this.store
        .prepare("INSERT INTO shift_slots(id, shift_id, position, scheduled_member_id, is_vacant) VALUES (?, ?, ?, ?, 0)")
        .run(randomUUID(), shiftId, index + 1, ensured.member.id);
    });
    return definition.people.length;
  }

  private transferAdjustments(oldShiftId: string, newShiftId: string, warnings: string[]): void {
    const oldStaff = this.store.prepare(`
      SELECT id, scheduled_member_id FROM shift_slots
      WHERE shift_id = ? AND is_vacant = 0 AND slot_source = 'manual' AND slot_role = 'staff'
      ORDER BY position
    `).all(oldShiftId) as unknown as Array<{ id: string; scheduled_member_id: string }>;
    for (const slot of oldStaff) {
      const duplicate = this.store.prepare(`
        SELECT id FROM shift_slots WHERE shift_id = ? AND scheduled_member_id = ? AND is_vacant = 0
      `).get(newShiftId, slot.scheduled_member_id) as { id: string } | undefined;
      if (duplicate) {
        this.store.prepare("UPDATE shift_slots SET is_vacant = 1 WHERE id = ?").run(slot.id);
        continue;
      }
      const position = this.store.prepare("SELECT COALESCE(MAX(position), 0) AS value FROM shift_slots WHERE shift_id = ?")
        .get(newShiftId) as { value: number };
      this.store.prepare("UPDATE shift_slots SET shift_id = ?, position = ? WHERE id = ?")
        .run(newShiftId, Number(position.value) + 1, slot.id);
    }

    const leaves = this.store.prepare(`
      SELECT lr.id, lr.member_id
      FROM leave_records lr JOIN shift_slots ss ON ss.id = lr.shift_slot_id
      WHERE ss.shift_id = ? AND lr.status = 'active'
    `).all(oldShiftId) as unknown as Array<{ id: string; member_id: string }>;
    for (const leave of leaves) {
      const target = this.store.prepare(`
        SELECT id FROM shift_slots
        WHERE shift_id = ? AND scheduled_member_id = ? AND is_vacant = 0
        ORDER BY position LIMIT 1
      `).get(newShiftId, leave.member_id) as { id: string } | undefined;
      if (target) {
        this.store.prepare("UPDATE leave_records SET shift_slot_id = ?, updated_at = ? WHERE id = ?")
          .run(target.id, new Date().toISOString(), leave.id);
      } else {
        this.store.prepare("UPDATE leave_records SET status = 'cancelled', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), leave.id);
        warnings.push("新排班中已没有原请假成员，对应请假已停用");
      }
    }
    this.syncRequiredSlots(newShiftId);
  }

  private syncRequiredSlots(shiftId: string): void {
    this.store.prepare(`
      UPDATE shifts SET required_slots = (
        SELECT COUNT(*) FROM shift_slots WHERE shift_id = ? AND is_vacant = 0
      ) WHERE id = ?
    `).run(shiftId, shiftId);
  }
}
