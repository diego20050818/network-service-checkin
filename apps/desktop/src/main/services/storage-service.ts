import { constants } from "node:fs";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SourceFileInfo, StorageOverview } from "../../shared/contracts";
import type { DatabaseStore } from "../database";
import type { SettingsService } from "./settings-service";

type ScheduleSourceRow = {
  source_name: string;
  source_path: string;
  month: string;
  effective_date: string;
  imported_at: string;
};

type MemberSourceRow = {
  source_name: string;
  source_path: string;
  imported_at: string;
  row_count: number;
};

export class StorageService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly settings: SettingsService,
    private readonly paths: {
      dataDirectory: string;
      templateDirectory: string;
      scheduleSourceDirectory: string;
      memberSourceDirectory: string;
    },
  ) {}

  async overview(): Promise<StorageOverview> {
    const activeScheduleRows = this.store
      .prepare(`
        SELECT si.source_name, si.source_path, si.month, si.effective_date, si.imported_at
        FROM schedule_imports si
        WHERE si.source_type = 'file' AND EXISTS (
          SELECT 1 FROM shifts s WHERE s.schedule_import_id = si.id AND s.active = 1
        )
        ORDER BY si.month DESC, si.imported_at DESC
      `)
      .all() as unknown as ScheduleSourceRow[];
    const latestMemberRow = this.store
      .prepare(`
        SELECT source_name, source_path, imported_at, row_count
        FROM member_imports
        ORDER BY imported_at DESC
        LIMIT 1
      `)
      .get() as MemberSourceRow | undefined;
    const templateNames = await this.readTemplateNames();

    return {
      dataDirectory: this.paths.dataDirectory,
      databasePath: this.store.path,
      templateDirectory: this.paths.templateDirectory,
      scheduleSourceDirectory: this.paths.scheduleSourceDirectory,
      memberSourceDirectory: this.paths.memberSourceDirectory,
      settings: this.settings.getStorage(),
      activeScheduleFiles: await Promise.all(
        activeScheduleRows.map((row) =>
          this.fileInfo(row.source_name, row.source_path, row.imported_at, `${row.month} · ${row.effective_date} 生效`),
        ),
      ),
      latestMemberFile: latestMemberRow
        ? await this.fileInfo(
            latestMemberRow.source_name,
            latestMemberRow.source_path,
            latestMemberRow.imported_at,
            `${latestMemberRow.row_count} 名成员`,
          )
        : null,
      templateFiles: await Promise.all(
        templateNames.map(async (name) => {
          const path = join(this.paths.templateDirectory, name);
          const information = await stat(path);
          const detail = ["网络服务小组排班导入模板.xlsx", "网络中心员工信息表格.xlsx"].includes(name) ? "导入模板" : "输出模板";
          return this.fileInfo(name, path, information.mtime.toISOString(), detail);
        }),
      ),
    };
  }

  async setDirectory(kind: "output" | "backup", directory: string): Promise<StorageOverview> {
    const target = resolve(directory);
    await mkdir(target, { recursive: true });
    await access(target, constants.R_OK | constants.W_OK);
    const current = this.settings.getStorage();
    this.settings.updateStorage({
      ...current,
      ...(kind === "output" ? { defaultOutputDirectory: target } : { backupDirectory: target }),
    });
    return this.overview();
  }

  managedRoots(): string[] {
    const storage = this.settings.getStorage();
    return [
      this.paths.dataDirectory,
      this.paths.templateDirectory,
      storage.defaultOutputDirectory,
      storage.backupDirectory,
    ].filter(Boolean);
  }

  private async fileInfo(name: string, path: string, importedAt: string, detail: string): Promise<SourceFileInfo> {
    return { name, path, importedAt, exists: await this.exists(path), detail };
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async readTemplateNames(): Promise<string[]> {
    try {
      return (await readdir(this.paths.templateDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.(docx|xlsx)$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, "zh-CN"));
    } catch {
      return [];
    }
  }
}
