import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 4;

export const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  college TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  student_id TEXT NOT NULL DEFAULT '',
  major TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '',
  employee_no TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_members_name ON members(name);

CREATE TABLE IF NOT EXISTS schedule_imports (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  month TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  UNIQUE(source_sha256, month)
);

CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  schedule_import_id TEXT NOT NULL REFERENCES schedule_imports(id),
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('desk', 'maintenance', 'weekend')),
  label TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  paid_minutes INTEGER NOT NULL CHECK (paid_minutes > 0),
  required_slots INTEGER NOT NULL CHECK (required_slots > 0),
  attendance_mode TEXT NOT NULL CHECK (attendance_mode IN ('lenient', 'late_mark')),
  late_threshold_minutes INTEGER NOT NULL CHECK (late_threshold_minutes >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE(schedule_import_id, date, kind, start_time, end_time)
);
CREATE INDEX IF NOT EXISTS ix_shifts_date_active ON shifts(date, active);

CREATE TABLE IF NOT EXISTS shift_slots (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  scheduled_member_id TEXT REFERENCES members(id),
  is_vacant INTEGER NOT NULL DEFAULT 0 CHECK (is_vacant IN (0, 1)),
  UNIQUE(shift_id, position)
);
CREATE INDEX IF NOT EXISTS ix_shift_slots_shift ON shift_slots(shift_id);

CREATE TABLE IF NOT EXISTS attendance_records (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  shift_slot_id TEXT NOT NULL REFERENCES shift_slots(id),
  actual_member_id TEXT NOT NULL REFERENCES members(id),
  punch_time TEXT,
  entered_at TEXT NOT NULL,
  paid_minutes INTEGER NOT NULL CHECK (paid_minutes > 0),
  late_status TEXT NOT NULL CHECK (late_status IN ('normal', 'late', 'manual_unjudged')),
  source TEXT NOT NULL CHECK (source IN ('realtime', 'manual')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  attendance_mode TEXT NOT NULL CHECK (attendance_mode IN ('lenient', 'late_mark')),
  late_threshold_minutes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_attendance_active_slot
  ON attendance_records(shift_slot_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS ux_attendance_active_member_shift
  ON attendance_records(shift_id, actual_member_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_attendance_member ON attendance_records(actual_member_id, status);

CREATE TABLE IF NOT EXISTS attendance_changes (
  id TEXT PRIMARY KEY,
  attendance_id TEXT NOT NULL REFERENCES attendance_records(id),
  change_type TEXT NOT NULL CHECK (change_type IN ('correct_member', 'revoke', 'restore', 'set_punch_time')),
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local_ui',
  changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report_drafts (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(year, month)
);

CREATE TABLE IF NOT EXISTS export_batches (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  filler TEXT NOT NULL,
  fill_date TEXT NOT NULL,
  output_directory TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  template_manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS export_files (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES export_batches(id) ON DELETE CASCADE,
  file_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  template_sha256 TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(batch_id, file_key)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS member_imports (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  UNIQUE(source_sha256)
);
`;

export const MIGRATION_3 = `
ALTER TABLE schedule_imports
  ADD COLUMN source_type TEXT NOT NULL DEFAULT 'file' CHECK (source_type IN ('file', 'system'));

ALTER TABLE shifts
  ADD COLUMN work_type TEXT NOT NULL DEFAULT 'regular' CHECK (work_type IN ('regular', 'overtime'));
ALTER TABLE shifts
  ADD COLUMN note TEXT NOT NULL DEFAULT '';

ALTER TABLE shift_slots
  ADD COLUMN slot_role TEXT NOT NULL DEFAULT 'responsible' CHECK (slot_role IN ('responsible', 'staff', 'overtime'));
ALTER TABLE shift_slots
  ADD COLUMN slot_source TEXT NOT NULL DEFAULT 'imported' CHECK (slot_source IN ('imported', 'manual'));
ALTER TABLE shift_slots
  ADD COLUMN slot_note TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS leave_records (
  id TEXT PRIMARY KEY,
  shift_slot_id TEXT NOT NULL REFERENCES shift_slots(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  replacement_member_id TEXT REFERENCES members(id),
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_leave_active_slot
  ON leave_records(shift_slot_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_leave_member_status
  ON leave_records(member_id, status);
`;

export const MIGRATION_4 = `
ALTER TABLE shifts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shifts ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report_drafts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE data_version (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
INSERT INTO data_version VALUES(1, 0);
CREATE TABLE shift_sources (
  shift_id TEXT PRIMARY KEY REFERENCES shifts(id),
  import_id TEXT NOT NULL REFERENCES schedule_imports(id),
  source_active INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL
);
CREATE TABLE operation_history (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, request_json TEXT NOT NULL,
  shift_ids_json TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
  result_json TEXT NOT NULL, created_at TEXT NOT NULL, undone_at TEXT
);
CREATE INDEX ix_operations_created ON operation_history(created_at);
CREATE TABLE formal_schedule_versions (import_id TEXT PRIMARY KEY REFERENCES schedule_imports(id), payload_json TEXT NOT NULL);
CREATE TABLE export_requests (id TEXT PRIMARY KEY, request_json TEXT NOT NULL, result_json TEXT NOT NULL);
`;

export class DatabaseStore {
  private transactionDepth = 0;
  private connectionValue: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.connectionValue = this.open(path);
    try {
      this.transaction(() => this.migrate());
    } catch (error) {
      this.connectionValue.close();
      if (path !== ":memory:")
        try {
          writeFileSync(
            path + ".migration-error.json",
            JSON.stringify(
              {
                time: new Date().toISOString(),
                message: error instanceof Error ? error.message : String(error),
              },
              null,
              2,
            ),
            "utf8",
          );
        } catch {
          /* Original data is kept even when diagnostic writing is unavailable. */
        }
      throw error;
    }
  }

  get connection(): DatabaseSync {
    return this.connectionValue;
  }

  prepare(sql: string): StatementSync {
    return this.connectionValue.prepare(sql);
  }

  transaction<T>(work: () => T): T {
    const depth = this.transactionDepth;
    const savepoint = `nested_${depth}`;
    this.connectionValue.exec(
      depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE",
    );
    this.transactionDepth++;
    try {
      const result = work();
      this.connectionValue.exec(depth ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      this.connectionValue.exec(
        depth ? `ROLLBACK TO ${savepoint}` : "ROLLBACK",
      );
      if (depth) this.connectionValue.exec(`RELEASE ${savepoint}`);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  backupTo(destination: string): void {
    if (existsSync(destination)) throw new Error("备份目标文件已存在");
    mkdirSync(dirname(destination), { recursive: true });
    const escaped = destination.replace(/'/g, "''");
    this.connectionValue.exec(`VACUUM INTO '${escaped}'`);
  }

  replaceFrom(source: string): void {
    if (this.path === ":memory:") throw new Error("内存数据库不能恢复");
    const staged = `${this.path}.restore-${Date.now()}`;
    copyFileSync(source, staged);
    try {
      const probe = new DatabaseStore(staged);
      try {
        if (
          probe.prepare("PRAGMA integrity_check").get()?.integrity_check !==
          "ok"
        )
          throw new Error("备份数据库完整性检查失败");
        if (probe.prepare("PRAGMA foreign_key_check").all().length)
          throw new Error("备份数据库关联检查失败");
        probe.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        probe.close();
      }
    } catch (error) {
      if (existsSync(staged)) unlinkSync(staged);
      throw error;
    }
    this.connectionValue.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const rollback = `${this.path}.pre-restore`;
    copyFileSync(this.path, rollback);
    this.connectionValue.close();
    try {
      for (const suffix of ["-wal", "-shm"])
        if (existsSync(this.path + suffix)) unlinkSync(this.path + suffix);
      copyFileSync(staged, this.path);
      this.connectionValue = this.open(this.path);
    } catch (error) {
      copyFileSync(rollback, this.path);
      this.connectionValue = this.open(this.path);
      throw error;
    } finally {
      if (existsSync(staged)) unlinkSync(staged);
    }
  }

  dataRevision(): number {
    return Number(
      this.prepare("SELECT revision FROM data_version WHERE id = 1").get()!
        .revision,
    );
  }

  captureSources(): void {
    this.prepare(
      `INSERT OR IGNORE INTO shift_sources(shift_id, import_id, source_active, payload_json)
      SELECT s.id, s.schedule_import_id, s.active, json_object('id', s.id, 'date', s.date, 'kind', s.kind,
        'label', s.label, 'startTime', s.start_time, 'endTime', s.end_time,
        'people', json((SELECT COALESCE(json_group_array(json_object('id', ss.id, 'memberId', ss.scheduled_member_id,
          'name', m.name, 'position', ss.position)), '[]') FROM shift_slots ss LEFT JOIN members m ON m.id = ss.scheduled_member_id
          WHERE ss.shift_id = s.id AND ss.slot_source = 'imported' AND ss.is_vacant = 0)))
      FROM shifts s JOIN schedule_imports si ON si.id = s.schedule_import_id
      WHERE si.source_type = 'file' AND s.work_type = 'regular'`,
    ).run();
  }

  close(): void {
    this.connectionValue.close();
  }

  private open(path: string): DatabaseSync {
    const db = new DatabaseSync(path, { timeout: 5_000 });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    return db;
  }

  private migrate(): void {
    const row = this.connectionValue.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (row.user_version > SCHEMA_VERSION) {
      throw new Error(
        `数据库版本 ${row.user_version} 高于应用支持版本 ${SCHEMA_VERSION}`,
      );
    }
    if (row.user_version < 1) {
      this.transaction(() => {
        this.connectionValue.exec(MIGRATION_1);
        this.connectionValue.exec("PRAGMA user_version = 1");
      });
    }
    if (row.user_version < 2) {
      this.transaction(() => {
        this.connectionValue.exec(MIGRATION_2);
        this.connectionValue.exec("PRAGMA user_version = 2");
      });
    }
    if (row.user_version < 3) {
      this.transaction(() => {
        this.connectionValue.exec(MIGRATION_3);
        this.connectionValue.exec("PRAGMA user_version = 3");
      });
    }
    if (row.user_version < 4) {
      this.transaction(() => {
        this.connectionValue.exec(MIGRATION_4);
        this.captureSources();
        for (const table of [
          "members",
          "shifts",
          "shift_slots",
          "attendance_records",
          "leave_records",
          "schedule_imports",
          "settings",
        ]) {
          for (const action of ["INSERT", "UPDATE", "DELETE"]) {
            this.connectionValue
              .exec(`CREATE TRIGGER dv_${table}_${action} AFTER ${action} ON ${table}
              BEGIN UPDATE data_version SET revision = revision + 1 WHERE id = 1; END`);
          }
        }
        this.connectionValue
          .exec(`CREATE TRIGGER shift_revision AFTER UPDATE ON shifts WHEN NEW.revision = OLD.revision
          BEGIN UPDATE shifts SET revision = revision + 1 WHERE id = NEW.id; END`);
        for (const table of [
          "shift_slots",
          "attendance_records",
          "leave_records",
        ]) {
          for (const action of ["INSERT", "UPDATE", "DELETE"]) {
            const ref = action === "DELETE" ? "OLD" : "NEW";
            const shift =
              table === "leave_records"
                ? `(SELECT shift_id FROM shift_slots WHERE id = ${ref}.shift_slot_id)`
                : `${ref}.shift_id`;
            this.connectionValue
              .exec(`CREATE TRIGGER sr_${table}_${action} AFTER ${action} ON ${table}
              BEGIN UPDATE shifts SET revision = revision + 1 WHERE id = ${shift}; END`);
          }
        }
        this.connectionValue.exec("PRAGMA user_version = 4");
      });
    }
  }
}
