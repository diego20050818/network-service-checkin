import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseStore } from "../database";
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
});
