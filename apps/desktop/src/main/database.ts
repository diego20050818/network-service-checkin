import { DatabaseSync, type StatementSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 3;

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

const MIGRATION_3 = `
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

export class DatabaseStore {
  private connectionValue: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.connectionValue = this.open(path);
    try {
      this.migrate();
    } catch (error) {
      this.connectionValue.close();
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
    this.connectionValue.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.connectionValue.exec("COMMIT");
      return result;
    } catch (error) {
      this.connectionValue.exec("ROLLBACK");
      throw error;
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
    this.connectionValue.close();
    copyFileSync(source, this.path);
    this.connectionValue = this.open(this.path);
    this.migrate();
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
    const row = this.connectionValue.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version > SCHEMA_VERSION) {
      throw new Error(`数据库版本 ${row.user_version} 高于应用支持版本 ${SCHEMA_VERSION}`);
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
  }
}
