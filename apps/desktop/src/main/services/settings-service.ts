import type { Settings, StorageSettings, UpdateMode, UpdateSettings } from "../../shared/contracts";
import { formatLocalDateTimeKey } from "../../domain/time";
import type { DatabaseStore } from "../database";

const DEFAULT_SETTINGS: Settings = {
  attendanceMode: "lenient",
  lateThresholdMinutes: 15,
  latePenaltyPoints: 1,
};

export class SettingsService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly storageDefaults: StorageSettings = { defaultOutputDirectory: "", backupDirectory: "" },
  ) {}

  get(): Settings {
    const row = this.store.prepare("SELECT value_json FROM settings WHERE key = 'attendance'").get() as
      | { value_json: string }
      | undefined;
    if (!row) return { ...DEFAULT_SETTINGS };
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value_json) as Partial<Settings>) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  update(settings: Settings, now = new Date()): Settings {
    if (!Number.isInteger(settings.lateThresholdMinutes) || settings.lateThresholdMinutes < 0 || settings.lateThresholdMinutes > 180) {
      throw new Error("迟到阈值必须是 0 到 180 的整数分钟");
    }
    if (!Number.isFinite(settings.latePenaltyPoints) || settings.latePenaltyPoints < 0 || settings.latePenaltyPoints > 30) {
      throw new Error("每次迟到扣分必须在 0 到 30 之间");
    }
    this.store.transaction(() => {
      this.store
        .prepare(`
          INSERT INTO settings(key, value_json, updated_at) VALUES('attendance', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `)
        .run(JSON.stringify(settings), now.toISOString());
      this.store
        .prepare(`
          UPDATE shifts
          SET attendance_mode = ?, late_threshold_minutes = ?
          WHERE active = 1
            AND date || 'T' || start_time > ?
            AND work_type = 'regular'
            AND NOT EXISTS (
              SELECT 1 FROM attendance_records ar WHERE ar.shift_id = shifts.id
            )
        `)
        .run(settings.attendanceMode, settings.lateThresholdMinutes, formatLocalDateTimeKey(now));
    });
    return this.get();
  }

  getUpdates(): UpdateSettings {
    const row = this.store.prepare("SELECT value_json FROM settings WHERE key = 'updates'").get() as
      | { value_json: string }
      | undefined;
    if (!row) return { mode: "manual" };
    try {
      const value = JSON.parse(row.value_json) as Partial<UpdateSettings>;
      return { mode: value.mode === "automatic" ? "automatic" : "manual" };
    } catch {
      return { mode: "manual" };
    }
  }

  setUpdateMode(mode: UpdateMode, now = new Date()): UpdateSettings {
    if (mode !== "manual" && mode !== "automatic") throw new Error("更新模式无效");
    this.store.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES('updates', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify({ mode }), now.toISOString());
    return this.getUpdates();
  }

  getStorage(): StorageSettings {
    const row = this.store.prepare("SELECT value_json FROM settings WHERE key = 'storage'").get() as
      | { value_json: string }
      | undefined;
    if (!row) return { ...this.storageDefaults };
    try {
      return { ...this.storageDefaults, ...(JSON.parse(row.value_json) as Partial<StorageSettings>) };
    } catch {
      return { ...this.storageDefaults };
    }
  }

  updateStorage(storage: StorageSettings, now = new Date()): StorageSettings {
    const value = {
      defaultOutputDirectory: storage.defaultOutputDirectory.trim(),
      backupDirectory: storage.backupDirectory.trim(),
    };
    if (!value.defaultOutputDirectory || !value.backupDirectory) throw new Error("导出目录和备份目录不能为空");
    this.store
      .prepare(`
        INSERT INTO settings(key, value_json, updated_at) VALUES('storage', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `)
      .run(JSON.stringify(value), now.toISOString());
    return this.getStorage();
  }
}
