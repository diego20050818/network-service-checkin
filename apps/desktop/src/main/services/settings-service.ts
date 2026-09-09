import type {
  Settings,
  ShiftKind,
  ShiftTimeKey,
  ShiftTimeSettings,
  ShiftTimeSettingsUpdateResult,
  StorageSettings,
  UpdateMode,
  UpdateSettings,
} from "../../shared/contracts";
import { formatLocalDateTimeKey } from "../../domain/time";
import type { DatabaseStore } from "../database";

const DEFAULT_SETTINGS: Settings = {
  attendanceMode: "lenient",
  lateThresholdMinutes: 15,
  latePenaltyPoints: 1,
};

export const DEFAULT_SHIFT_TIME_SETTINGS: ShiftTimeSettings = {
  weekdayDesk1: { startTime: "08:00", endTime: "10:00" },
  weekdayDesk2: { startTime: "10:00", endTime: "12:00" },
  weekdayDesk3: { startTime: "14:30", endTime: "16:15" },
  weekdayDesk4: { startTime: "16:15", endTime: "17:30" },
  maintenance: { startTime: "17:00", endTime: "19:00" },
  weekendMorning: { startTime: "09:00", endTime: "12:00" },
  weekendAfternoon: { startTime: "14:30", endTime: "17:30" },
};

const SHIFT_TIME_KEYS = Object.keys(
  DEFAULT_SHIFT_TIME_SETTINGS,
) as ShiftTimeKey[];
const SHIFT_TIME_KIND: Record<ShiftTimeKey, ShiftKind> = {
  weekdayDesk1: "desk",
  weekdayDesk2: "desk",
  weekdayDesk3: "desk",
  weekdayDesk4: "desk",
  maintenance: "maintenance",
  weekendMorning: "weekend",
  weekendAfternoon: "weekend",
};
const SHIFT_KIND_LABEL: Record<ShiftKind, string> = {
  desk: "工作日坐班",
  maintenance: "维修班",
  weekend: "周末坐班",
};
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function cloneShiftTimes(value: ShiftTimeSettings): ShiftTimeSettings {
  return Object.fromEntries(
    SHIFT_TIME_KEYS.map((key) => [key, { ...value[key] }]),
  ) as ShiftTimeSettings;
}

function minutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour! * 60 + minute!;
}

function validateShiftTimes(value: ShiftTimeSettings): ShiftTimeSettings {
  const normalized = {} as ShiftTimeSettings;
  for (const key of SHIFT_TIME_KEYS) {
    const range = value?.[key];
    if (
      !range ||
      !TIME_PATTERN.test(range.startTime) ||
      !TIME_PATTERN.test(range.endTime)
    )
      throw new Error("班次时间必须使用 HH:mm 格式");
    if (minutes(range.endTime) <= minutes(range.startTime))
      throw new Error(
        `${SHIFT_KIND_LABEL[SHIFT_TIME_KIND[key]]}的结束时间必须晚于开始时间，且不能跨午夜`,
      );
    normalized[key] = { ...range };
  }
  for (const kind of ["desk", "maintenance", "weekend"] as const) {
    const seen = new Set<string>();
    for (const key of SHIFT_TIME_KEYS.filter(
      (candidate) => SHIFT_TIME_KIND[candidate] === kind,
    )) {
      const range = normalized[key];
      const signature = `${range.startTime}-${range.endTime}`;
      if (seen.has(signature))
        throw new Error(`${SHIFT_KIND_LABEL[kind]}不能配置重复时段 ${signature}`);
      seen.add(signature);
    }
  }
  return normalized;
}

function matchingTimeKey(
  settings: ShiftTimeSettings,
  kind: ShiftKind,
  startTime: string,
  endTime: string,
): ShiftTimeKey | undefined {
  return SHIFT_TIME_KEYS.find(
    (key) =>
      SHIFT_TIME_KIND[key] === kind &&
      settings[key].startTime === startTime &&
      settings[key].endTime === endTime,
  );
}

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

  getShiftTimeSettings(): ShiftTimeSettings {
    const row = this.store
      .prepare("SELECT value_json FROM settings WHERE key = 'shift_times'")
      .get() as { value_json: string } | undefined;
    if (!row) return cloneShiftTimes(DEFAULT_SHIFT_TIME_SETTINGS);
    try {
      const saved = JSON.parse(row.value_json) as Partial<ShiftTimeSettings>;
      const merged = cloneShiftTimes(DEFAULT_SHIFT_TIME_SETTINGS);
      for (const key of SHIFT_TIME_KEYS)
        if (saved[key]) merged[key] = { ...saved[key]! };
      return validateShiftTimes(merged);
    } catch {
      return cloneShiftTimes(DEFAULT_SHIFT_TIME_SETTINGS);
    }
  }

  updateShiftTimeSettings(
    settings: ShiftTimeSettings,
    now = new Date(),
  ): ShiftTimeSettingsUpdateResult {
    const next = validateShiftTimes(settings);
    const previous = this.getShiftTimeSettings();
    const nowKey = formatLocalDateTimeKey(now);
    let updatedShiftCount = 0;
    this.store.transaction(() => {
      const rows = this.store
        .prepare(`
          SELECT s.id, s.schedule_import_id, s.date, s.kind, s.label,
            s.start_time, s.end_time, src.payload_json
          FROM shifts s
          JOIN schedule_imports si ON si.id = s.schedule_import_id
          JOIN shift_sources src ON src.shift_id = s.id
          WHERE s.active = 1 AND s.cancelled = 0
            AND s.work_type = 'regular' AND si.source_type = 'file'
            AND s.date || 'T' || s.start_time > ?
            AND NOT EXISTS (
              SELECT 1 FROM attendance_records ar WHERE ar.shift_id = s.id
            )
          ORDER BY s.date, s.start_time, s.id
        `)
        .all(nowKey) as Array<{
        id: string;
        schedule_import_id: string;
        date: string;
        kind: ShiftKind;
        label: string;
        start_time: string;
        end_time: string;
        payload_json: string;
      }>;
      for (const row of rows) {
        let source: {
          date?: string;
          startTime?: string;
          endTime?: string;
        };
        try {
          source = JSON.parse(row.payload_json) as typeof source;
        } catch {
          continue;
        }
        if (
          source.date !== row.date ||
          source.startTime !== row.start_time ||
          source.endTime !== row.end_time
        )
          continue;
        const key = matchingTimeKey(
          previous,
          row.kind,
          row.start_time,
          row.end_time,
        );
        if (!key) continue;
        const target = next[key];
        if (
          target.startTime === row.start_time &&
          target.endTime === row.end_time
        )
          continue;
        const conflict = this.store
          .prepare(`
            SELECT id FROM shifts
            WHERE schedule_import_id = ? AND date = ? AND kind = ?
              AND start_time = ? AND end_time = ? AND id <> ?
          `)
          .get(
            row.schedule_import_id,
            row.date,
            row.kind,
            target.startTime,
            target.endTime,
            row.id,
          );
        if (conflict)
          throw new Error(
            `${row.date} ${row.label} ${row.start_time}–${row.end_time} 无法改为 ${target.startTime}–${target.endTime}：与现有班次冲突，设置未保存`,
          );
        this.store
          .prepare(`
            UPDATE shifts
            SET start_time = ?, end_time = ?, paid_minutes = ?
            WHERE id = ?
          `)
          .run(
            target.startTime,
            target.endTime,
            minutes(target.endTime) - minutes(target.startTime),
            row.id,
          );
        updatedShiftCount += 1;
      }
      this.store
        .prepare(`
          INSERT INTO settings(key, value_json, updated_at)
          VALUES('shift_times', ?, ?)
          ON CONFLICT(key) DO UPDATE
          SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `)
        .run(JSON.stringify(next), now.toISOString());
    });
    return {
      settings: this.getShiftTimeSettings(),
      updatedShiftCount,
    };
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
