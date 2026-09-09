import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseScheduleWorkbook } from "./schedule-parser";
import { createThreeBlockSchedule, createWeekendMatrixSchedule } from "./schedule-fixture.test-util";
import { writeScheduleImportTemplate } from "./schedule-template";
import { DEFAULT_SHIFT_TIME_SETTINGS } from "./settings-service";
import ExcelJS from "exceljs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("三块排班解析", () => {
  it("按区域标签和星期展开，不硬编码周日维修名单", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkin-schedule-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "网络小组排班表_2026.08.xlsx");
    await createThreeBlockSchedule(path);
    const result = await parseScheduleWorkbook(path, "2026-08");
    const sundayMaintenance = result.shifts.find((shift) => shift.date === "2026-08-02" && shift.kind === "maintenance");
    expect(sundayMaintenance?.people).toEqual(["李佳欣", "洪浩洋"]);
    expect(result.shifts.some((shift) => shift.kind === "desk" && shift.paidMinutes === 75)).toBe(true);
    expect(result.shifts.some((shift) => shift.kind === "weekend" && shift.date === "2026-08-01" && shift.paidMinutes === 180)).toBe(true);
  });

  it("第五个周末没有名单时保持未排并给出提示", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkin-schedule-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "fixture.xlsx");
    await createThreeBlockSchedule(path);
    const result = await parseScheduleWorkbook(path, "2026-08");
    expect(result.shifts.some((shift) => shift.kind === "weekend" && shift.date === "2026-08-29")).toBe(false);
    expect(result.shifts.some((shift) => shift.kind === "weekend" && shift.date === "2026-08-30")).toBe(false);
    expect(result.warnings.some((warning) => warning.includes("第 5 个周六"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("第 5 个周日"))).toBe(true);
  });

  it("识别周末上午下午分列的周次矩阵，明确时段不被上午下午标签覆写", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkin-schedule-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "周末矩阵.xlsx");
    await createWeekendMatrixSchedule(path);
    const result = await parseScheduleWorkbook(path, "2026-09");
    const weekend = result.shifts.filter((shift) => shift.kind === "weekend");
    expect(weekend).toHaveLength(16);
    expect(weekend.find((shift) => shift.date === "2026-09-05" && shift.startTime === "09:00")).toMatchObject({
      endTime: "12:00",
      paidMinutes: 180,
      people: ["方萌"],
    });
    expect(weekend.find((shift) => shift.date === "2026-09-06" && shift.startTime === "14:30")).toMatchObject({
      endTime: "17:30",
      paidMinutes: 180,
      people: ["范浩天"],
    });
  });

  it("动态模板可由 ExcelJS 往返读取并按当前 7 条时段重新解析", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkin-template-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "动态排班模板.xlsx");
    const configured = {
      ...DEFAULT_SHIFT_TIME_SETTINGS,
      weekdayDesk1: { startTime: "08:15", endTime: "10:15" },
      maintenance: { startTime: "17:15", endTime: "19:15" },
      weekendMorning: { startTime: "09:15", endTime: "12:15" },
    };
    await writeScheduleImportTemplate(path, configured);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path);
    const sheet = workbook.worksheets[0]!;
    sheet.getCell("B3").value = "甲";
    sheet.getCell("B10").value = "甲、乙、丙";
    sheet.getCell("C14").value = "周六上午";
    sheet.getCell("D14").value = "周六下午";
    await workbook.xlsx.writeFile(path);

    const parsed = await parseScheduleWorkbook(path, "2026-09");
    expect(
      parsed.shifts.find(
        (shift) => shift.kind === "desk" && shift.date === "2026-09-07",
      ),
    ).toMatchObject({ startTime: "08:15", endTime: "10:15", paidMinutes: 120 });
    expect(
      parsed.shifts.find(
        (shift) => shift.kind === "maintenance" && shift.date === "2026-09-07",
      ),
    ).toMatchObject({ startTime: "17:15", endTime: "19:15", paidMinutes: 120 });
    expect(
      parsed.shifts.find(
        (shift) => shift.kind === "weekend" && shift.date === "2026-09-05",
      ),
    ).toMatchObject({ startTime: "09:15", endTime: "12:15", paidMinutes: 180 });
  });

  it("随包静态模板是标准工作簿并使用新的默认时段", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(
      resolve(
        __dirname,
        "../../../resources/templates/网络服务小组排班导入模板.xlsx",
      ),
    );
    const sheet = workbook.worksheets[0];
    expect(sheet?.name).toBe("排班");
    expect(sheet?.getCell("A3").text).toBe("08:00–10:00");
    expect(sheet?.getCell("A10").text).toBe("17:00–19:00");
    expect(sheet?.getCell("C13").text).toBe("09:00–12:00");
    expect(sheet?.getCell("D13").text).toBe("14:30–17:30");
  });
});
