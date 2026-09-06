import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseScheduleWorkbook } from "./schedule-parser";
import { createThreeBlockSchedule, createWeekendMatrixSchedule } from "./schedule-fixture.test-util";

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

  it("识别周末上午下午分列的周次矩阵，并按 4h 和 3h 计算", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkin-schedule-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "周末矩阵.xlsx");
    await createWeekendMatrixSchedule(path);
    const result = await parseScheduleWorkbook(path, "2026-09");
    const weekend = result.shifts.filter((shift) => shift.kind === "weekend");
    expect(weekend).toHaveLength(16);
    expect(weekend.find((shift) => shift.date === "2026-09-05" && shift.startTime === "08:00")).toMatchObject({
      endTime: "12:00",
      paidMinutes: 240,
      people: ["方萌"],
    });
    expect(weekend.find((shift) => shift.date === "2026-09-06" && shift.startTime === "14:30")).toMatchObject({
      endTime: "17:30",
      paidMinutes: 180,
      people: ["范浩天"],
    });
  });
});
