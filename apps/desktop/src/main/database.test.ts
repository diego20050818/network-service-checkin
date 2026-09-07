import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseStore, MIGRATION_1, MIGRATION_2, SCHEMA_VERSION } from "./database";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("DatabaseStore migrations", () => {
  it("将 0.4 schema v2 数据库增量升级并保留旧数据", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkin-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "app.sqlite3");
    const previous = new DatabaseSync(path);
    previous.exec(MIGRATION_1);
    previous.exec(MIGRATION_2);
    previous.prepare(`INSERT INTO members(id, name, created_at, updated_at) VALUES ('member-1', '旧成员', '2026-01-01', '2026-01-01')`).run();
    previous.prepare(`INSERT INTO schedule_imports(id, source_name, source_path, source_sha256, month, effective_date, imported_at) VALUES ('import-1', '旧排班.xlsx', 'old.xlsx', 'old-hash', '2026-09', '2026-09-01', '2026-09-01')`).run();
    previous.prepare(`INSERT INTO shifts(id, schedule_import_id, date, kind, label, start_time, end_time, paid_minutes, required_slots, attendance_mode, late_threshold_minutes, created_at) VALUES ('shift-1', 'import-1', '2026-09-07', 'desk', '坐班', '08:00', '10:00', 120, 1, 'lenient', 15, '2026-09-01')`).run();
    previous.prepare(`INSERT INTO shift_slots(id, shift_id, position, scheduled_member_id) VALUES ('slot-1', 'shift-1', 1, 'member-1')`).run();
    previous.exec("PRAGMA user_version = 2");
    previous.close();

    const store = new DatabaseStore(path);
    try {
      expect((store.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      expect((store.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'member_imports'").get() as { name: string }).name).toBe("member_imports");
      expect((store.prepare("SELECT name FROM members WHERE id = 'member-1'").get() as { name: string }).name).toBe("旧成员");
      expect(store.prepare("SELECT work_type, note FROM shifts WHERE id = 'shift-1'").get()).toEqual({ work_type: "regular", note: "" });
      expect(store.prepare("SELECT slot_role, slot_source, slot_note FROM shift_slots WHERE id = 'slot-1'").get()).toEqual({ slot_role: "responsible", slot_source: "imported", slot_note: "" });
      expect((store.prepare("SELECT source_type FROM schedule_imports WHERE id = 'import-1'").get() as { source_type: string }).source_type).toBe("file");
      expect((store.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'leave_records'").get() as { name: string }).name).toBe("leave_records");
    } finally {
      store.close();
    }
  });
});
