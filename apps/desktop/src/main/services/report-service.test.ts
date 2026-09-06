import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ExcelJS from "exceljs";
import PizZip from "pizzip";
import { afterEach, describe, expect, it } from "vitest";
import { defaultReportDraft } from "../../domain/report";
import { DatabaseStore } from "../database";
import { AttendanceService } from "./attendance-service";
import { DashboardService } from "./dashboard-service";
import { MemberService } from "./member-service";
import { ReportService } from "./report-service";
import { SettingsService } from "./settings-service";
import { addScheduleImport, addShift } from "./test-helpers.test-util";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("ReportService", () => {
  it("从同一工时快照生成五类可打开文件且不残留占位符", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkin-report-"));
    temporaryDirectories.push(directory);
    const store = new DatabaseStore(":memory:");
    try {
      const members = new MemberService(store);
      const settings = new SettingsService(store);
      const attendance = new AttendanceService(store, members);
      const dashboard = new DashboardService(store, attendance, members);
      const importId = addScheduleImport(store);
      const scheduleSource = join(directory, "客户正式排班.xlsx");
      const scheduleWorkbook = new ExcelJS.Workbook();
      const scheduleWorksheet = scheduleWorkbook.addWorksheet("原始排班表");
      scheduleWorksheet.addRows([["值班日期", "负责人"], ["2026-09-07", "甲"]]);
      await scheduleWorkbook.xlsx.writeFile(scheduleSource);
      store.prepare("UPDATE schedule_imports SET source_path = ?, source_name = ? WHERE id = ?").run(scheduleSource, "客户正式排班.xlsx", importId);
      const desk = addShift(store, members, { importId, date: "2026-09-07", kind: "desk", startTime: "16:15", endTime: "17:30", paidMinutes: 75, people: ["甲"] });
      const maintenance = addShift(store, members, { importId, date: "2026-09-07", kind: "maintenance", startTime: "17:00", endTime: "19:00", paidMinutes: 120, people: ["甲", "乙", null] });
      const weekend = addShift(store, members, { importId, date: "2026-09-06", kind: "weekend", startTime: "08:00", endTime: "12:00", paidMinutes: 240, people: ["甲"] });
      attendance.checkIn(weekend.shiftId, [{ slotId: weekend.slotIds[0]!, memberId: weekend.memberIds.甲! }], "2026-09-06T09:00:00+08:00");
      attendance.checkIn(desk.shiftId, [{ slotId: desk.slotIds[0]!, memberId: desk.memberIds.甲! }], "2026-09-07T17:10:00+08:00");
      attendance.checkIn(maintenance.shiftId, [
        { slotId: maintenance.slotIds[0]!, memberId: maintenance.memberIds.甲! },
        { slotId: maintenance.slotIds[1]!, memberId: maintenance.memberIds.乙! },
      ], "2026-09-07T17:10:00+08:00");
      const service = new ReportService(store, dashboard, members, settings, resolve("resources/templates"));
      const draft = {
        ...defaultReportDraft(2026, 9),
        filler: "张三",
        outputDirectory: directory,
        workItems: ["完成网络巡检", "处理报修", "整理设备"] as [string, string, string],
        questions: ["问题一", "问题二", "问题三"] as [string, string, string],
        reflections: ["对策一", "对策二", "对策三"] as [string, string, string],
        plans: ["计划一", "计划二", "计划三"] as [string, string, string],
        advice: "无",
        wageWorkloads: { [desk.memberIds.甲!]: "4h" },
      };
      const result = await service.export(draft);
      expect(result.files).toHaveLength(5);
      expect(result.warnings.filter((warning) => warning.includes("生成失败"))).toEqual([]);

      const workbookFile = result.files.find((file) => file.key === "timeRecord")!;
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(workbookFile.path);
      expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["工时记录", "签到明细"]);
      expect(workbook.getWorksheet("签到明细")?.rowCount).toBe(5);
      expect(workbook.getWorksheet("工时记录")?.getCell("D2").value).toBe("工时（h）");
      const memberTitles = Array.from({ length: 15 }, (_, index) => String(workbook.getWorksheet("工时记录")?.getCell(1, 1 + index * 9).value ?? ""));
      expect(memberTitles.some((title) => title.includes("甲") && title.includes("工时：7.25h"))).toBe(true);
      expect(workbook.getWorksheet("签到明细")?.getCell("J1").value).toBe("计薪工时（h）");

      for (const file of result.files.filter((item) => item.fileName.endsWith(".docx"))) {
        const zip = new PizZip(await readFile(file.path));
        const xml = zip.file("word/document.xml")?.asText() ?? "";
        expect(xml).not.toMatch(/\[(?:mouth|name|date|work\d|question\d|think\d|plan\d|advice|int<|student_id|reason|time|year|mm|hours)/i);
      }
      const scheduleFile = result.files.find((file) => file.key === "schedule")!;
      const scheduleXml = new PizZip(await readFile(scheduleFile.path)).file("word/document.xml")?.asText() ?? "";
      expect(scheduleXml).toContain("2026-09-07");
      expect(scheduleXml).toContain("原始排班表");
      expect(scheduleXml).toContain("值班日期");
      const wageFile = result.files.find((file) => file.key === "wageAssessment")!;
      const wageXml = new PizZip(await readFile(wageFile.path)).file("word/document.xml")?.asText() ?? "";
      const wageText = [...wageXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => match[1]).join("");
      expect(wageText).toContain("4h");

      const systemDefaultPreview = service.preview({ ...draft, wageWorkloads: {} });
      const wageRows = systemDefaultPreview.files.find((file) => file.key === "wageAssessment")?.tables[0]?.rows ?? [];
      expect(wageRows.some((row) => row.includes("甲") && row.includes("7.25h"))).toBe(true);

      const snapshot = JSON.parse(
        (store.prepare("SELECT snapshot_json FROM export_batches WHERE id = ?").get(result.batchId) as { snapshot_json: string }).snapshot_json,
      ) as { dashboard: { metrics: { paidMinutes: number } } };
      expect(snapshot.dashboard.metrics.paidMinutes).toBe(555);
    } finally {
      store.close();
    }
  }, 20_000);

  it("文件名重名时创建新批次目录而不覆盖", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkin-report-"));
    temporaryDirectories.push(directory);
    const store = new DatabaseStore(":memory:");
    try {
      const members = new MemberService(store);
      const settings = new SettingsService(store);
      const attendance = new AttendanceService(store, members);
      const dashboard = new DashboardService(store, attendance, members);
      const service = new ReportService(store, dashboard, members, settings, resolve("resources/templates"));
      const draft = { ...defaultReportDraft(2026, 9), filler: "张三", outputDirectory: directory, selectedFiles: ["workReport"] as const };
      const first = await service.export({ ...draft, selectedFiles: [...draft.selectedFiles] });
      const second = await service.export({ ...draft, selectedFiles: [...draft.selectedFiles] });
      expect(second.directory).not.toBe(first.directory);
    } finally {
      store.close();
    }
  });
});
