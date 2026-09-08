import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { afterEach, expect, it } from "vitest";
import { DatabaseStore } from "../database";
import { ImportPreviewService } from "./import-preview-service";
import { ScheduleService } from "./schedule-service";
import { MemberService } from "./member-service";
import { SettingsService } from "./settings-service";
import { AttendanceService } from "./attendance-service";
import { AdjustmentService } from "./adjustment-service";
import { OccurrenceService } from "./occurrence-service";
import { ReportService } from "./report-service";
import { DashboardService } from "./dashboard-service";
import { createThreeBlockSchedule } from "./schedule-fixture.test-util";
const dirs: string[] = [];
const stores: DatabaseStore[] = [];
afterEach(async () => {
  stores.splice(0).forEach((s) => s.close());
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "checkin-preview-"));
  dirs.push(dir);
  const store = new DatabaseStore(":memory:");
  stores.push(store);
  const members = new MemberService(store, join(dir, "members"));
  const settings = new SettingsService(store);
  const schedule = new ScheduleService(store, members, join(dir, "sources"));
  const attendance = new AttendanceService(store, members);
  const adjustments = new AdjustmentService(store, members, attendance);
  const occurrences = new OccurrenceService(
    store,
    attendance,
    adjustments,
    members,
  );
  const service = new ImportPreviewService(store, schedule, members, settings);
  const path = join(dir, "schedule.xlsx");
  await createThreeBlockSchedule(path);
  return {
    dir,
    store,
    members,
    settings,
    schedule,
    service,
    path,
    occurrences,
    attendance,
  };
}
const options = {
  kind: "schedule" as const,
  month: "2099-09",
  effectiveDate: "2099-09-01",
};
it("解析预览不写业务数据，文件或数据变化后拒绝应用", async () => {
  const { store, service, path, members } = await setup();
  const revision = store.dataRevision();
  const preview = await service.preview(path, options);
  expect(preview.additions.length).toBeGreaterThan(50);
  expect(store.dataRevision()).toBe(revision);
  expect(members.list()).toEqual([]);
  members.save({ name: "另一个操作" });
  await expect(
    service.apply({ id: preview.id, resolutions: {} }),
  ).rejects.toThrow(/已变化/);
  const next = await service.preview(path, options);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  workbook.worksheets[0]!.getCell("Z50").value = "new";
  await workbook.xlsx.writeFile(path);
  await expect(service.apply({ id: next.id, resolutions: {} })).rejects.toThrow(
    /已变化/,
  );
  expect(store.prepare("SELECT COUNT(*) AS n FROM shifts").get()!.n).toBe(0);
});
it("重导必须处理移动、取消和历史关联；保留原 ID 且正式来源独立", async () => {
  const { service, path, store, occurrences, attendance, members, settings } =
    await setup();
  const first = await service.preview(path, options);
  await service.apply({ id: first.id, resolutions: {} });
  const all = occurrences.list({
    startDate: "2099-09-01",
    endDate: "2099-09-30",
  });
  const moving = all[0]!;
  const cancelled = all[1]!;
  const history = all[2]!;
  occurrences.save({
    id: moving.id,
    expectedRevision: moving.revision,
    operationId: randomUUID(),
    date: "2099-10-01",
    kind: moving.kind,
    workType: "regular",
    startTime: moving.startTime,
    endTime: moving.endTime,
    label: moving.label,
    note: "单次移动",
    memberIds: moving.slots.map((s) => s.scheduledMemberId!),
  });
  occurrences.cancel({
    id: cancelled.id,
    expectedRevision: cancelled.revision,
    operationId: randomUUID(),
  });
  const record = attendance.addManual({
    slotId: history.slots[0]!.id,
    memberId: history.slots[0]!.scheduledMemberId!,
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  workbook.worksheets[0]!.getCell("Z50").value = "new import";
  await workbook.xlsx.writeFile(path);
  const preview = await service.preview(path, options);
  expect(preview.conflicts.map((c) => c.id)).toEqual(
    expect.arrayContaining([moving.id, cancelled.id, history.id]),
  );
  await expect(
    service.apply({ id: preview.id, resolutions: {} }),
  ).rejects.toThrow(/逐项/);
  await service.apply({
    id: preview.id,
    resolutions: Object.fromEntries(
      preview.conflicts.map((c) => [c.id, "keep"]),
    ),
  });
  expect(occurrences.get(moving.id).date).toBe("2099-10-01");
  expect(occurrences.get(cancelled.id).active).toBe(false);
  expect(attendance.getRecord(record.id).paidMinutes).toBe(history.paidMinutes);
  expect(occurrences.get(history.id).slots[0]!.id).toBe(history.slots[0]!.id);
  const report = new ReportService(
    store,
    new DashboardService(store, attendance, members),
    members,
    settings,
    resolve("resources/templates"),
  );
  const draft = report.getDraft(2099, 9);
  draft.startDate = "2099-09-01";
  draft.endDate = "2099-09-30";
  const lines = report.preview(draft).files.find((f) => f.key === "schedule")!
    .tables[0]!.rows;
  expect(
    lines.some(
      (line) =>
        line[0] === moving.date &&
        line[2] === moving.startTime + "-" + moving.endTime,
    ),
  ).toBe(true);
  expect(lines.some((line) => line[0] === "2099-10-01")).toBe(false);
});
it("同名成员不会模糊合并，成员文件重复姓名不能应用", async () => {
  const { service, dir, members } = await setup();
  members.save({ name: "同名" });
  members.save({ name: "同名" });
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("成员").addRows([
    ["姓名", "学号"],
    ["同名", "001"],
    ["同名", "002"],
  ]);
  const path = join(dir, "members.xlsx");
  await workbook.xlsx.writeFile(path);
  const preview = await service.preview(path, { ...options, kind: "members" });
  expect(preview.conflicts.length).toBeGreaterThan(0);
  expect(preview.warnings.length).toBeGreaterThan(0);
  await expect(
    service.apply({ id: preview.id, resolutions: { 同名: "keep" } }),
  ).rejects.toThrow(/同名|重复/);
  expect(members.list().map((m) => m.studentId)).toEqual(["", ""]);
});
