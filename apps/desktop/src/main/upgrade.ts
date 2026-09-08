import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMA_VERSION } from "./database";
import { hashFiles, verifyFiles } from "./backup-files";

/** Runs before DatabaseStore construction: failures must abort startup. */
export async function prepareUpgrade(
  dataDirectory: string,
  templateDirectory: string,
): Promise<string | null> {
  const databasePath = join(dataDirectory, "app.sqlite3");
  if (!existsSync(databasePath)) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = Number(
      database.prepare("PRAGMA user_version").get()!.user_version,
    );
    if (version >= SCHEMA_VERSION) return null;
    if (
      database.prepare("PRAGMA integrity_check").get()!.integrity_check !== "ok"
    )
      throw new Error("升级前数据库完整性检查失败");
    const directory = join(
      dataDirectory,
      "upgrade-backups",
      `schema-${version}-to-${SCHEMA_VERSION}-${Date.now()}`,
    );
    await mkdir(directory, { recursive: true });
    const target = join(directory, "app.sqlite3");
    database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    for (const [source, name] of [
      [join(dataDirectory, "schedule-sources"), "schedule-sources"],
      [join(dataDirectory, "member-sources"), "member-sources"],
      [templateDirectory, "templates"],
    ]) {
      if (source && name && existsSync(source)) {
        const before = await hashFiles(source);
        await cp(source, join(directory, name), {
          recursive: true,
          errorOnExist: true,
        });
        await verifyFiles(join(directory, name), before);
      }
    }
    const probe = new DatabaseSync(target, { readOnly: true });
    try {
      if (
        probe.prepare("PRAGMA integrity_check").get()!.integrity_check !== "ok"
      )
        throw new Error("升级备份完整性校验失败");
      if (probe.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("升级备份存在无效数据关联");
    } finally {
      probe.close();
    }
    const digest = createHash("sha256")
      .update(await readFile(target))
      .digest("hex");
    const files = await hashFiles(directory);
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify(
        {
          version: 2,
          kind: "manual",
          purpose: "pre_upgrade",
          schemaVersion: version,
          targetSchemaVersion: SCHEMA_VERSION,
          createdAt: new Date().toISOString(),
          databaseFile: "app.sqlite3",
          databaseSha256: digest,
          files,
        },
        null,
        2,
      ),
      "utf8",
    );
    return directory;
  } finally {
    database.close();
  }
}
