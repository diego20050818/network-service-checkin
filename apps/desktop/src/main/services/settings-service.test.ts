import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseStore } from "../database";
import { AttendanceService } from "./attendance-service";
import { MemberService } from "./member-service";
import {
  DEFAULT_SHIFT_TIME_SETTINGS,
  SettingsService,
} from "./settings-service";
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

  it("仅安全同步未开始且未人工改时的正式班次，并保留班次、席位和请假 ID", () => {
    const importId = addScheduleImport(store);
    const safe = addShift(store, members, {
      importId,
      date: "2026-09-08",
      kind: "desk",
      startTime: "08:00",
      endTime: "10:00",
      paidMinutes: 120,
      people: ["甲"],
    });
    const manuallyChanged = addShift(store, members, {
      importId,
      date: "2026-09-08",
      kind: "desk",
      startTime: "10:00",
      endTime: "12:00",
      paidMinutes: 120,
      people: ["乙"],
    });
    const historical = addShift(store, members, {
      importId,
      date: "2026-09-08",
      kind: "desk",
      startTime: "14:30",
      endTime: "16:15",
      paidMinutes: 105,
      people: ["丙"],
    });
    const customSource = addShift(store, members, {
      importId,
      date: "2026-09-08",
      kind: "desk",
      startTime: "13:00",
      endTime: "14:00",
      paidMinutes: 60,
      people: ["丁"],
    });
    const systemImportId = addScheduleImport(store);
    const manual = addShift(store, members, {
      importId: systemImportId,
      date: "2026-09-09",
      kind: "desk",
      startTime: "08:00",
      endTime: "10:00",
      paidMinutes: 120,
      people: ["戊"],
    });
    store.captureSources();
    store
      .prepare("UPDATE schedule_imports SET source_type='system' WHERE id=?")
      .run(systemImportId);
    store
      .prepare(
        "UPDATE shifts SET start_time='10:05', end_time='12:05' WHERE id=?",
      )
      .run(manuallyChanged.shiftId);
    attendance.addManual({
      slotId: historical.slotIds[0]!,
      memberId: historical.memberIds.丙!,
      historicalPunchTime: null,
    });
    store
      .prepare(`
        INSERT INTO leave_records(id,shift_slot_id,member_id,reason,status,created_at,updated_at)
        VALUES('leave-safe',?,?, '测试', 'active', ?, ?)
      `)
      .run(
        safe.slotIds[0]!,
        safe.memberIds.甲!,
        "2026-09-06T12:00:00.000Z",
        "2026-09-06T12:00:00.000Z",
      );
    const previousRevision = Number(
      store
        .prepare("SELECT revision FROM shifts WHERE id=?")
        .get(safe.shiftId)!.revision,
    );
    const next = structuredClone(DEFAULT_SHIFT_TIME_SETTINGS);
    next.weekdayDesk1 = { startTime: "08:15", endTime: "10:30" };
    next.weekdayDesk2 = { startTime: "10:15", endTime: "12:15" };
    next.weekdayDesk3 = { startTime: "14:45", endTime: "16:30" };

    const result = settings.updateShiftTimeSettings(
      next,
      new Date("2026-09-06T12:00:00+08:00"),
    );

    expect(result).toMatchObject({ settings: next, updatedShiftCount: 1 });
    expect(
      store
        .prepare(
          "SELECT id,start_time,end_time,paid_minutes,revision FROM shifts WHERE id=?",
        )
        .get(safe.shiftId),
    ).toMatchObject({
      id: safe.shiftId,
      start_time: "08:15",
      end_time: "10:30",
      paid_minutes: 135,
      revision: previousRevision + 1,
    });
    expect(
      store
        .prepare("SELECT id,shift_id FROM shift_slots WHERE id=?")
        .get(safe.slotIds[0]!),
    ).toMatchObject({ id: safe.slotIds[0], shift_id: safe.shiftId });
    expect(
      store.prepare("SELECT id FROM leave_records WHERE id='leave-safe'").get(),
    ).toEqual({ id: "leave-safe" });
    for (const [shiftId, startTime, endTime] of [
      [manuallyChanged.shiftId, "10:05", "12:05"],
      [historical.shiftId, "14:30", "16:15"],
      [customSource.shiftId, "13:00", "14:00"],
      [manual.shiftId, "08:00", "10:00"],
    ])
      expect(
        store
          .prepare("SELECT start_time,end_time FROM shifts WHERE id=?")
          .get(shiftId!),
      ).toEqual({ start_time: startTime, end_time: endTime });
  });

  it("冲突时整次回滚班次与设置并给出具体原因", () => {
    const importId = addScheduleImport(store);
    const source = addShift(store, members, {
      importId,
      date: "2026-09-08",
      kind: "desk",
      startTime: "08:00",
      endTime: "10:00",
      paidMinutes: 120,
      people: ["甲"],
    });
    addShift(store, members, {
      importId,
      date: "2026-09-08",
      kind: "desk",
      startTime: "08:30",
      endTime: "10:30",
      paidMinutes: 120,
      people: ["乙"],
    });
    store.captureSources();
    const next = structuredClone(DEFAULT_SHIFT_TIME_SETTINGS);
    next.weekdayDesk1 = { startTime: "08:30", endTime: "10:30" };

    expect(() =>
      settings.updateShiftTimeSettings(
        next,
        new Date("2026-09-06T12:00:00+08:00"),
      ),
    ).toThrow("2026-09-08 工作日坐班 08:00–10:00 无法改为 08:30–10:30");
    expect(settings.getShiftTimeSettings()).toEqual(DEFAULT_SHIFT_TIME_SETTINGS);
    expect(
      store
        .prepare("SELECT start_time,end_time FROM shifts WHERE id=?")
        .get(source.shiftId),
    ).toEqual({ start_time: "08:00", end_time: "10:00" });
  });

  it("拒绝跨午夜、结束不晚于开始和同类重复时段", () => {
    for (const invalid of [
      { startTime: "18:00", endTime: "08:00" },
      { startTime: "10:00", endTime: "10:00" },
    ]) {
      const next = structuredClone(DEFAULT_SHIFT_TIME_SETTINGS);
      next.maintenance = invalid;
      expect(() => settings.updateShiftTimeSettings(next)).toThrow(
        "结束时间必须晚于开始时间",
      );
    }
    const duplicate = structuredClone(DEFAULT_SHIFT_TIME_SETTINGS);
    duplicate.weekdayDesk2 = { ...duplicate.weekdayDesk1 };
    expect(() => settings.updateShiftTimeSettings(duplicate)).toThrow(
      "工作日坐班不能配置重复时段",
    );
  });
});
