import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseStore } from "../database";
import { MemberService } from "./member-service";
import { SettingsService } from "./settings-service";
import { StorageService } from "./storage-service";
import { addScheduleImport, addShift } from "./test-helpers.test-util";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("StorageService", () => {
  it("显示当前排班、员工、模板和可配置目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkin-storage-"));
    temporaryDirectories.push(root);
    const dataDirectory = join(root, "data");
    const scheduleSourceDirectory = join(dataDirectory, "schedule-sources");
    const memberSourceDirectory = join(dataDirectory, "member-sources");
    const templateDirectory = join(root, "templates");
    const outputDirectory = join(dataDirectory, "exports");
    const backupDirectory = join(dataDirectory, "backups");
    await Promise.all([mkdir(scheduleSourceDirectory, { recursive: true }), mkdir(memberSourceDirectory, { recursive: true }), mkdir(templateDirectory, { recursive: true })]);
    await writeFile(join(templateDirectory, "排版模板.docx"), "template");
    const schedulePath = join(scheduleSourceDirectory, "当前排班.xlsx");
    await writeFile(schedulePath, "schedule");

    const store = new DatabaseStore(join(dataDirectory, "app.sqlite3"));
    try {
      const settings = new SettingsService(store, { defaultOutputDirectory: outputDirectory, backupDirectory });
      const members = new MemberService(store, memberSourceDirectory);
      const memberFile = join(root, "员工.xlsx");
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet("员工").addRows([["姓名", "职务"], ["甲", "值班员"]]);
      await workbook.xlsx.writeFile(memberFile);
      await members.importWorkbook(memberFile);

      const importId = addScheduleImport(store, "2026-09");
      store.prepare("UPDATE schedule_imports SET source_name = ?, source_path = ? WHERE id = ?").run("当前排班.xlsx", schedulePath, importId);
      addShift(store, members, { importId, date: "2026-09-08", kind: "desk", startTime: "08:00", endTime: "10:00", paidMinutes: 120, people: ["甲"] });

      const service = new StorageService(store, settings, { dataDirectory, templateDirectory, scheduleSourceDirectory, memberSourceDirectory });
      const overview = await service.overview();
      expect(overview.activeScheduleFiles).toMatchObject([{ name: "当前排班.xlsx", exists: true }]);
      expect(overview.latestMemberFile).toMatchObject({ name: "员工.xlsx", exists: true, detail: "1 名成员" });
      expect(overview.templateFiles).toMatchObject([{ name: "排版模板.docx", exists: true }]);

      const customOutput = join(root, "custom-output");
      const updated = await service.setDirectory("output", customOutput);
      expect(updated.settings.defaultOutputDirectory).toBe(customOutput);
      await expect(access(customOutput)).resolves.toBeUndefined();
    } finally {
      store.close();
    }
  });
});
