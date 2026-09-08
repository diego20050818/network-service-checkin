import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  DatabaseStore,
  MIGRATION_1,
  MIGRATION_2,
  MIGRATION_3,
  SCHEMA_VERSION,
} from "./database";
import { prepareUpgrade } from "./upgrade";
import { defaultReportDraft } from "../domain/report";
import { BackupService } from "./services/backup-service";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function legacy(version: number) {
  const root = await mkdtemp(join(tmpdir(), "checkin-upgrade-"));
  directories.push(root);
  const data = join(root, "data");
  const templates = join(root, "templates");
  await mkdir(data);
  await mkdir(templates);
  for (const folder of ["schedule-sources", "member-sources"]) {
    await mkdir(join(data, folder));
    await writeFile(
      join(data, folder, "source.xlsx"),
      "legacy-source-" + folder,
    );
  }
  await writeFile(join(templates, "template.docx"), "legacy-template");
  const path = join(data, "app.sqlite3");
  const db = new DatabaseSync(path);
  db.exec(MIGRATION_1 + MIGRATION_2 + (version === 3 ? MIGRATION_3 : ""));
  db.prepare(
    "INSERT INTO members(id,name,student_id,created_at,updated_at) VALUES('m1','旧成员','00123','2026-01-01','2026-01-01'),('m2','代班人','00999','2026-01-01','2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO schedule_imports(id,source_name,source_path,source_sha256,month,effective_date,imported_at) VALUES('i1','source.xlsx',?,'sha','2026-09','2026-09-01','2026-09-01')",
  ).run(join(data, "schedule-sources", "source.xlsx"));
  db.prepare(
    "INSERT INTO shifts(id,schedule_import_id,date,kind,label,start_time,end_time,paid_minutes,required_slots,attendance_mode,late_threshold_minutes,created_at) VALUES('s1','i1','2026-09-01','desk','原班次','08:07','09:22',75,2,'late_mark',12,'2026-09-01')",
  ).run();
  db.prepare(
    "INSERT INTO shift_slots(id,shift_id,position,scheduled_member_id) VALUES('slot1','s1',1,'m1'),('slot2','s1',2,'m2')",
  ).run();
  db.prepare(
    "INSERT INTO attendance_records(id,shift_id,shift_slot_id,actual_member_id,punch_time,entered_at,paid_minutes,late_status,source,status,attendance_mode,late_threshold_minutes,created_at,updated_at) VALUES('a1','s1','slot1','m1','2026-09-01T00:08:00Z','2026-09-01',75,'normal','realtime','active','late_mark',12,'2026-09-01','2026-09-01')",
  ).run();
  if (version === 3)
    db.prepare(
      "INSERT INTO leave_records(id,shift_slot_id,member_id,reason,created_at,updated_at) VALUES('l1','slot2','m2','旧请假','2026-09-01','2026-09-01')",
    ).run();
  const draft = {
    ...defaultReportDraft(2026, 9),
    advice: "旧草稿不可丢失",
    scores: {
      m1: {
        attendance: 27,
        hours: 8,
        self: 9,
        peer: 18,
        supervisor: 28,
        activity: 2,
      },
    },
  };
  db.prepare(
    "INSERT INTO report_drafts(id,year,month,payload_json,updated_at) VALUES('d1',2026,9,?,'2026-09-01')",
  ).run(JSON.stringify(draft));
  db.exec("PRAGMA user_version=" + version);
  const tables = [
    "members",
    "schedule_imports",
    "shifts",
    "shift_slots",
    "attendance_records",
    "report_drafts",
    ...(version === 3 ? ["leave_records"] : []),
  ];
  const before = Object.fromEntries(
    tables.map((table) => [
      table,
      db.prepare("SELECT * FROM " + table + " ORDER BY id").all(),
    ]),
  );
  db.close();
  return { root, data, templates, path, tables, before };
}
for (const version of [2, 3])
  it(
    "schema " + version + " 升级前备份且逐列保留历史 ID、工时、草稿及源文件",
    async () => {
      const fixture = await legacy(version);
      const backup = await prepareUpgrade(fixture.data, fixture.templates);
      expect(backup).toContain("upgrade-backups");
      const manifest = JSON.parse(
        await readFile(join(backup!, "manifest.json"), "utf8"),
      );
      expect(manifest.purpose).toBe("pre_upgrade");
      expect(Object.keys(manifest.files)).toHaveLength(4);
      const raw = new DatabaseSync(join(backup!, "app.sqlite3"), {
        readOnly: true,
      });
      expect(raw.prepare("PRAGMA user_version").get()!.user_version).toBe(
        version,
      );
      raw.close();
      const store = new DatabaseStore(fixture.path);
      try {
        for (const table of fixture.tables) {
          const original = fixture.before[table]!;
          const columns = Object.keys(original[0]!);
          expect(
            store
              .prepare(
                "SELECT " +
                  columns.join(",") +
                  " FROM " +
                  table +
                  " ORDER BY id",
              )
              .all(),
          ).toEqual(original);
        }
        expect(store.prepare("PRAGMA user_version").get()!.user_version).toBe(
          SCHEMA_VERSION,
        );
        expect(store.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(
          await prepareUpgrade(fixture.data, fixture.templates),
        ).toBeNull();
        const backups = new BackupService(
          store,
          join(fixture.data, "backups"),
          fixture.templates,
          join(fixture.data, "schedule-sources"),
        );
        await backups.create("daily");
        expect(
          await readdir(join(fixture.data, "upgrade-backups")),
        ).toHaveLength(1);
      } finally {
        store.close();
      }
    },
  );
it("升级备份失败不启动迁移", async () => {
  const fixture = await legacy(3);
  await writeFile(join(fixture.data, "upgrade-backups"), "blocks directory");
  await expect(
    prepareUpgrade(fixture.data, fixture.templates),
  ).rejects.toThrow();
  const db = new DatabaseSync(fixture.path, { readOnly: true });
  try {
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(3);
    expect(
      db.prepare("SELECT paid_minutes FROM attendance_records").get()!
        .paid_minutes,
    ).toBe(75);
  } finally {
    db.close();
  }
});
it("跨版本迁移失败整笔回滚，并保留原库与诊断", async () => {
  const fixture = await legacy(2);
  const old = new DatabaseSync(fixture.path);
  old.exec("CREATE TABLE operation_history(id TEXT)");
  old.close();
  expect(() => new DatabaseStore(fixture.path)).toThrow();
  const db = new DatabaseSync(fixture.path, { readOnly: true });
  try {
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(2);
    expect(
      db
        .prepare("PRAGMA table_info(shifts)")
        .all()
        .some((c) => c.name === "work_type"),
    ).toBe(false);
    expect(db.prepare("SELECT id FROM attendance_records").get()!.id).toBe(
      "a1",
    );
  } finally {
    db.close();
  }
  expect(
    JSON.parse(await readFile(fixture.path + ".migration-error.json", "utf8"))
      .message,
  ).toContain("operation_history");
});
it("恢复迁移失败保留当前数据库，备份文件损坏也会阻止恢复", async () => {
  const fixture = await legacy(3);
  const store = new DatabaseStore(fixture.path);
  try {
    const backupService = new BackupService(
      store,
      join(fixture.data, "backups"),
      fixture.templates,
      join(fixture.data, "schedule-sources"),
    );
    const backup = await backupService.create();
    await writeFile(
      join(backup, "schedule-sources", "source.xlsx"),
      "tampered",
    );
    await expect(backupService.restore(backup)).rejects.toThrow(/文件校验/);
    expect(store.prepare("SELECT id FROM attendance_records").get()!.id).toBe(
      "a1",
    );
    const invalid = join(fixture.root, "invalid");
    await mkdir(invalid);
    const db = new DatabaseSync(join(invalid, "app.sqlite3"));
    db.exec("PRAGMA user_version=999");
    db.close();
    const hash = createHash("sha256")
      .update(await readFile(join(invalid, "app.sqlite3")))
      .digest("hex");
    await writeFile(
      join(invalid, "manifest.json"),
      JSON.stringify({
        version: 2,
        kind: "manual",
        databaseFile: "app.sqlite3",
        databaseSha256: hash,
      }),
    );
    await expect(backupService.restore(invalid)).rejects.toThrow(/高于/);
    expect(
      store.prepare("SELECT paid_minutes FROM attendance_records").get()!
        .paid_minutes,
    ).toBe(75);
  } finally {
    store.close();
  }
});

for (const version of [2, 3])
  it(
    "恢复 schema " + version + " 旧清单备份，在临时副本迁移后保留所有历史列",
    async () => {
      const fixture = await legacy(version);
      const archive = join(fixture.root, "old-backup");
      await mkdir(archive);
      await cp(fixture.path, join(archive, "app.sqlite3"));
      await cp(
        join(fixture.data, "schedule-sources"),
        join(archive, "schedule-sources"),
        { recursive: true },
      );
      const databaseSha256 = createHash("sha256")
        .update(await readFile(join(archive, "app.sqlite3")))
        .digest("hex");
      await writeFile(
        join(archive, "manifest.json"),
        JSON.stringify({
          version: 1,
          kind: "manual",
          databaseFile: "app.sqlite3",
          databaseSha256,
        }),
      );
      const current = join(fixture.root, "current");
      await mkdir(current);
      const store = new DatabaseStore(join(current, "app.sqlite3"));
      try {
        const service = new BackupService(
          store,
          join(current, "backups"),
          fixture.templates,
          join(current, "schedule-sources"),
        );
        await service.restore(archive);
        for (const table of fixture.tables) {
          const original = fixture.before[table]!;
          const columns = Object.keys(original[0]!).filter(
            (c) => c !== "source_path",
          );
          expect(
            store
              .prepare(
                "SELECT " +
                  columns.join(",") +
                  " FROM " +
                  table +
                  " ORDER BY id",
              )
              .all(),
          ).toEqual(
            original.map((r) =>
              Object.fromEntries(columns.map((c) => [c, r[c]])),
            ),
          );
        }
        expect(store.prepare("PRAGMA user_version").get()!.user_version).toBe(
          SCHEMA_VERSION,
        );
        expect(
          await readFile(
            join(current, "schedule-sources", "source.xlsx"),
            "utf8",
          ),
        ).toBe("legacy-source-schedule-sources");
      } finally {
        store.close();
      }
    },
  );

it("恢复归档同名冲突不会覆盖当前源文件或数据库", async () => {
  const fixture = await legacy(3);
  const store = new DatabaseStore(fixture.path);
  try {
    const service = new BackupService(
      store,
      join(fixture.data, "backups"),
      fixture.templates,
      join(fixture.data, "schedule-sources"),
    );
    const backup = await service.create();
    await writeFile(
      join(fixture.data, "schedule-sources", "source.xlsx"),
      "new-current-source",
    );
    await expect(service.restore(backup)).rejects.toThrow(/同名/);
    expect(
      await readFile(
        join(fixture.data, "schedule-sources", "source.xlsx"),
        "utf8",
      ),
    ).toBe("new-current-source");
    expect(
      store.prepare("SELECT paid_minutes FROM attendance_records").get()!
        .paid_minutes,
    ).toBe(75);
  } finally {
    store.close();
  }
});
