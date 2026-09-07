import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { DatabaseStore } from "../database";
import { AdjustmentService } from "./adjustment-service";
import { AttendanceService } from "./attendance-service";
import { MemberService } from "./member-service";
import { ScheduleService } from "./schedule-service";
import { createThreeBlockSchedule } from "./schedule-fixture.test-util";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("ScheduleService", () => {
  it("保存源文件、建立班次席位，并对相同文件保持幂等", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkin-import-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "排班.xlsx");
    await createThreeBlockSchedule(source);
    const store = new DatabaseStore(":memory:");
    try {
      const members = new MemberService(store);
      const service = new ScheduleService(store, members, join(directory, "sources"));
      const first = await service.import(source, "2026-08", "2026-08-01", { attendanceMode: "lenient", lateThresholdMinutes: 15, latePenaltyPoints: 1 });
      const second = await service.import(source, "2026-08", "2026-08-01", { attendanceMode: "late_mark", lateThresholdMinutes: 5, latePenaltyPoints: 2 });
      expect(first.duplicate).toBe(false);
      expect(first.shiftCount).toBe(89);
      expect(first.slotCount).toBeGreaterThan(first.shiftCount);
      expect(first.createdMembers).toContain("李佳欣");
      expect(second.duplicate).toBe(true);
      expect(second.importId).toBe(first.importId);
      expect((store.prepare("SELECT COUNT(*) AS count FROM schedule_imports").get() as { count: number }).count).toBe(1);

      store.prepare("DELETE FROM shifts WHERE kind = 'weekend'").run();
      const repaired = await service.import(source, "2026-08", "2026-08-01", { attendanceMode: "lenient", lateThresholdMinutes: 15, latePenaltyPoints: 1 });
      expect(repaired.duplicate).toBe(false);
      expect((store.prepare("SELECT COUNT(*) AS count FROM shifts WHERE kind = 'weekend'").get() as { count: number }).count).toBeGreaterThan(0);
      expect((await service.import(source, "2026-08", "2026-08-01", { attendanceMode: "lenient", lateThresholdMinutes: 15, latePenaltyPoints: 1 })).duplicate).toBe(true);
    } finally {
      store.close();
    }
  });

  it("重新导入完全匹配班次时继承请假与单次增员", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkin-reimport-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "排班.xlsx");
    await createThreeBlockSchedule(source);
    const store = new DatabaseStore(":memory:");
    try {
      const members = new MemberService(store);
      const attendance = new AttendanceService(store, members);
      const adjustments = new AdjustmentService(store, members, attendance);
      const service = new ScheduleService(store, members, join(directory, "sources"));
      await service.import(source, "2099-08", "2099-08-01", { attendanceMode: "lenient", lateThresholdMinutes: 15, latePenaltyPoints: 1 });
      const oldShift = store.prepare("SELECT id FROM shifts WHERE active = 1 ORDER BY date, start_time LIMIT 1").get() as { id: string };
      const original = attendance.getShift(oldShift.id)!;
      const originalSlot = original.slots[0]!;
      adjustments.createLeave({ slotId: originalSlot.id, reason: "课程冲突" }, new Date("2099-07-01T00:00:00+08:00"));
      const staff = members.ensureMinimal("临时办公人员").member;
      adjustments.addShiftStaff({ shiftId: oldShift.id, memberId: staff.id });

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(source);
      workbook.worksheets[0]!.getCell("Z50").value = "重新导入";
      await workbook.xlsx.writeFile(source);
      const result = await service.import(source, "2099-08", "2099-08-01", { attendanceMode: "lenient", lateThresholdMinutes: 15, latePenaltyPoints: 1 });
      expect(result.duplicate).toBe(false);
      const newShift = store.prepare(`
        SELECT id FROM shifts WHERE active = 1 AND date = ? AND kind = ? AND start_time = ? AND end_time = ?
      `).get(original.date, original.kind, original.startTime, original.endTime) as { id: string };
      expect(newShift.id).not.toBe(oldShift.id);
      const transferred = attendance.getShift(newShift.id)!;
      expect(transferred.slots.some((slot) => slot.source === "manual" && slot.role === "staff" && slot.scheduledMemberId === staff.id)).toBe(true);
      expect(transferred.slots.find((slot) => slot.scheduledMemberId === originalSlot.scheduledMemberId)?.leave?.reason).toBe("课程冲突");
    } finally {
      store.close();
    }
  }, 20_000);
});
