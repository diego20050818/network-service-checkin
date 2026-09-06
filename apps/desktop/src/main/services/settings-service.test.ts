import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseStore } from "../database";
import { AttendanceService } from "./attendance-service";
import { MemberService } from "./member-service";
import { SettingsService } from "./settings-service";
import { addScheduleImport, addShift } from "./test-helpers.test-util";

describe("SettingsService", () => {
  let store: DatabaseStore;
  let members: MemberService;
  let settings: SettingsService;
  let attendance: AttendanceService;

  beforeEach(() => {
    store = new DatabaseStore(":memory:");
    members = new MemberService(store);
    settings = new SettingsService(store);
    attendance = new AttendanceService(store, members);
  });
  afterEach(() => store.close());

  it("新设置只更新未开始且没有签到记录的班次", () => {
    const importId = addScheduleImport(store);
    const past = addShift(store, members, { importId, date: "2026-09-05", kind: "desk", startTime: "08:00", endTime: "10:00", paidMinutes: 120, people: ["甲"] });
    const futureWithRecord = addShift(store, members, { importId, date: "2026-09-07", kind: "desk", startTime: "08:00", endTime: "10:00", paidMinutes: 120, people: ["乙"] });
    const futureEmpty = addShift(store, members, { importId, date: "2026-09-08", kind: "desk", startTime: "08:00", endTime: "10:00", paidMinutes: 120, people: ["丙"] });
    attendance.addManual({ slotId: futureWithRecord.slotIds[0]!, memberId: futureWithRecord.memberIds.乙!, historicalPunchTime: null });

    settings.update(
      { attendanceMode: "late_mark", lateThresholdMinutes: 20, latePenaltyPoints: 2 },
      new Date("2026-09-06T12:00:00+08:00"),
    );

    const rows = store.prepare("SELECT id, attendance_mode, late_threshold_minutes FROM shifts ORDER BY date").all() as Array<{
      id: string;
      attendance_mode: string;
      late_threshold_minutes: number;
    }>;
    expect(rows.find((row) => row.id === past.shiftId)).toMatchObject({ attendance_mode: "lenient", late_threshold_minutes: 15 });
    expect(rows.find((row) => row.id === futureWithRecord.shiftId)).toMatchObject({ attendance_mode: "lenient", late_threshold_minutes: 15 });
    expect(rows.find((row) => row.id === futureEmpty.shiftId)).toMatchObject({ attendance_mode: "late_mark", late_threshold_minutes: 20 });
  });

  it("保存导出和备份目录且保留默认值", () => {
    const service = new SettingsService(store, { defaultOutputDirectory: "C:\\exports", backupDirectory: "C:\\backups" });
    expect(service.getStorage()).toEqual({ defaultOutputDirectory: "C:\\exports", backupDirectory: "C:\\backups" });
    expect(service.updateStorage({ defaultOutputDirectory: "D:\\reports", backupDirectory: "D:\\safe" })).toEqual({
      defaultOutputDirectory: "D:\\reports",
      backupDirectory: "D:\\safe",
    });
  });
});
