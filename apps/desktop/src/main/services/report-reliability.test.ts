import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { DatabaseStore } from "../database";
import { defaultReportDraft } from "../../domain/report";
import { AttendanceService } from "./attendance-service";
import { MemberService } from "./member-service";
import { DashboardService } from "./dashboard-service";
import { SettingsService } from "./settings-service";
import { ReportService } from "./report-service";
import { addScheduleImport, addShift } from "./test-helpers.test-util";
const stores: DatabaseStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
function setup() {
  const store = new DatabaseStore(":memory:");
  stores.push(store);
  const members = new MemberService(store);
  const attendance = new AttendanceService(store, members);
  const service = new ReportService(
    store,
    new DashboardService(store, attendance, members),
    members,
    new SettingsService(store),
    resolve("resources/templates"),
  );
  const shift = addShift(store, members, {
    importId: addScheduleImport(store),
    date: "2026-09-07",
    kind: "desk",
    startTime: "09:07",
    endTime: "10:22",
    paidMinutes: 75,
    people: ["甲"],
  });
  const record = attendance.addManual({
    slotId: shift.slotIds[0]!,
    memberId: shift.memberIds.甲!,
  });
  return { store, members, attendance, service, shift, record };
}
it("草稿 revision 拒绝旧写入，允许空导出选择的草稿保存", () => {
  const { service } = setup();
  const original = service.getDraft(2026, 9);
  const saved = service.saveDraft({
    ...original,
    advice: "new",
    selectedFiles: [],
  });
  expect(saved.revision).toBe(1);
  expect(() => service.saveDraft({ ...original, advice: "old" })).toThrow(
    /其他保存更新/,
  );
  expect(service.getDraft(2026, 9).advice).toBe("new");
});
it("导出校验数据与草稿版本；并发或重试同操作只生成一个批次", async () => {
  const { service, store, members } = setup();
  const dir = await mkdtemp(join(tmpdir(), "report-reliability-"));
  dirs.push(dir);
  const draft = service.saveDraft({
    ...service.getDraft(2026, 9),
    outputDirectory: dir,
    selectedFiles: ["workReport"],
  });
  const revision = store.dataRevision();
  members.save({ name: "乙" });
  await expect(service.export(draft, revision, randomUUID())).rejects.toThrow(
    /数据已变化/,
  );
  const id = randomUUID();
  const first = service.export(draft, store.dataRevision(), id);
  await expect(
    service.export({ ...draft, advice: "other" }, store.dataRevision(), id),
  ).rejects.toThrow(/标识/);
  const second = service.export(draft, store.dataRevision(), id);
  const [a, b] = await Promise.all([first, second]);
  expect(a.batchId).toBe(b.batchId);
  expect((await service.export(draft, store.dataRevision(), id)).batchId).toBe(
    a.batchId,
  );
  expect(
    store.prepare("SELECT COUNT(*) AS n FROM export_batches").get()!.n,
  ).toBe(1);
});
it("快照捕获后的实际考勤变化不会改变本批 Excel 或保存的统计", async () => {
  const { service, store, attendance, record } = setup();
  const dir = await mkdtemp(join(tmpdir(), "report-frozen-"));
  dirs.push(dir);
  const draft = service.saveDraft({
    ...defaultReportDraft(2026, 9),
    revision: 0,
    outputDirectory: dir,
    selectedFiles: ["timeRecord"],
  });
  const original = store.backupTo.bind(store);
  vi.spyOn(store, "backupTo").mockImplementation((path) => {
    original(path);
    attendance.revoke(record.id);
  });
  const result = await service.export(draft, store.dataRevision());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(result.files[0]!.path);
  expect(workbook.getWorksheet("签到明细")!.getCell("L2").value).toBe(1.25);
  const snapshot = JSON.parse(
    String(
      store.prepare("SELECT snapshot_json FROM export_batches").get()!
        .snapshot_json,
    ),
  );
  expect(snapshot.dashboard.metrics.paidMinutes).toBe(75);
  expect(service.preview(draft).snapshot.metrics.paidMinutes).toBe(0);
});
