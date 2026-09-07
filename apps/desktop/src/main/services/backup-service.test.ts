import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseStore, MIGRATION_1, MIGRATION_2, SCHEMA_VERSION } from "../database";
import { BackupService } from "./backup-service";
import { MemberService } from "./member-service";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("BackupService", () => {
  it("使用 SQLite 安全快照备份并可恢复", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkin-backup-"));
    temporaryDirectories.push(directory);
    const data = join(directory, "data");
    const sources = join(data, "schedule-sources");
    await mkdir(sources, { recursive: true });
    const store = new DatabaseStore(join(data, "app.sqlite3"));
    try {
      const members = new MemberService(store);
      members.save({ name: "甲" });
      const service = new BackupService(store, join(data, "backups"), resolve("resources/templates"), sources);
      const backup = await service.create("manual");
      expect(await service.list()).toMatchObject([{ path: backup, kind: "manual", valid: true }]);
      members.save({ name: "乙" });
      expect(members.list().map((member) => member.name)).toEqual(["乙", "甲"]);
      await service.restoreManaged(backup);
      expect(members.list().map((member) => member.name)).toEqual(["甲"]);
      await expect(service.restoreManaged(data)).rejects.toThrow("只能恢复当前备份目录中的备份");
      await writeFile(join(backup, "app.sqlite3"), "corrupted");
      expect(await service.list()).toEqual(expect.arrayContaining([expect.objectContaining({ path: backup, valid: false })]));
      await expect(service.restoreManaged(backup)).rejects.toThrow("备份数据库校验失败");
    } finally {
      store.close();
    }
  });

  it("恢复 0.4 manifest v2 备份后自动迁移到当前 schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkin-v04-restore-"));
    temporaryDirectories.push(directory);
    const data = join(directory, "data");
    const backupRoot = join(data, "backups");
    const backup = join(backupRoot, "manual_v0.4.0");
    const sources = join(data, "schedule-sources");
    await mkdir(backup, { recursive: true });
    await mkdir(sources, { recursive: true });
    const backupDatabase = join(backup, "app.sqlite3");
    const previous = new DatabaseSync(backupDatabase);
    previous.exec(MIGRATION_1);
    previous.exec(MIGRATION_2);
    previous.prepare("INSERT INTO members(id, name, created_at, updated_at) VALUES ('old-member', '旧版成员', '2026-01-01', '2026-01-01')").run();
    previous.exec("PRAGMA user_version = 2");
    previous.close();
    const digest = createHash("sha256").update(await readFile(backupDatabase)).digest("hex");
    await writeFile(join(backup, "manifest.json"), JSON.stringify({
      version: 2,
      createdAt: "2026-04-25T00:00:00.000Z",
      kind: "manual",
      databaseFile: "app.sqlite3",
      databaseSha256: digest,
    }), "utf8");

    const store = new DatabaseStore(join(data, "app.sqlite3"));
    try {
      const service = new BackupService(store, backupRoot, resolve("resources/templates"), sources);
      await service.restoreManaged(backup);
      expect((store.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      expect((store.prepare("SELECT name FROM members WHERE id = 'old-member'").get() as { name: string }).name).toBe("旧版成员");
      expect((store.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'leave_records'").get() as { name: string }).name).toBe("leave_records");
    } finally {
      store.close();
    }
  });
});
