import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseStore } from "./database";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("DatabaseStore migrations", () => {
  it("将 0.2 数据库升级并增加员工导入来源表", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkin-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "app.sqlite3");
    const previous = new DatabaseSync(path);
    previous.exec("PRAGMA user_version = 1");
    previous.close();

    const store = new DatabaseStore(path);
    try {
      expect((store.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
      expect((store.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'member_imports'").get() as { name: string }).name).toBe("member_imports");
    } finally {
      store.close();
    }
  });
});
