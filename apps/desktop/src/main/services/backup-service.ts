import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { formatLocalDate } from "../../domain/time";
import type { BackupEntry } from "../../shared/contracts";
import type { DatabaseStore } from "../database";

interface BackupManifest {
  version: 1 | 2;
  createdAt: string;
  kind: "daily" | "manual" | "pre_restore";
  databaseFile: string;
  databaseSha256: string;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export class BackupService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly backupRoot: string | (() => string),
    private readonly templateDirectory: string,
    private readonly scheduleSourceDirectory: string,
    private readonly memberSourceDirectory?: string,
  ) {}

  async ensureDaily(): Promise<string | null> {
    const today = formatLocalDate(new Date());
    const row = this.store.prepare("SELECT value_json FROM settings WHERE key = 'last_daily_backup'").get() as
      | { value_json: string }
      | undefined;
    if (row && JSON.parse(row.value_json) === today) return null;
    const directory = await this.create("daily");
    this.store
      .prepare(`
        INSERT INTO settings(key, value_json, updated_at) VALUES('last_daily_backup', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `)
      .run(JSON.stringify(today), new Date().toISOString());
    return directory;
  }

  async create(kind: BackupManifest["kind"] = "manual"): Promise<string> {
    const now = new Date();
    const backupRoot = this.currentRoot();
    await mkdir(backupRoot, { recursive: true });
    const directory = join(backupRoot, `${kind}_${stamp(now)}`);
    await mkdir(directory, { recursive: false });
    const databaseFile = join(directory, "app.sqlite3");
    this.store.backupTo(databaseFile);
    await this.copyOptionalDirectory(this.templateDirectory, join(directory, "templates"));
    await this.copyOptionalDirectory(this.scheduleSourceDirectory, join(directory, "schedule-sources"));
    if (this.memberSourceDirectory) await this.copyOptionalDirectory(this.memberSourceDirectory, join(directory, "member-sources"));
    const databaseSha256 = createHash("sha256").update(await readFile(databaseFile)).digest("hex");
    const manifest: BackupManifest = {
      version: 2,
      createdAt: now.toISOString(),
      kind,
      databaseFile: "app.sqlite3",
      databaseSha256,
    };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await this.retainLatest(30);
    return directory;
  }

  async restore(directory: string): Promise<void> {
    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BackupManifest;
    if (![1, 2].includes(manifest.version) || manifest.databaseFile !== "app.sqlite3") throw new Error("备份清单版本不受支持");
    const databaseFile = join(directory, manifest.databaseFile);
    const actualSha256 = createHash("sha256").update(await readFile(databaseFile)).digest("hex");
    if (actualSha256 !== manifest.databaseSha256) throw new Error("备份数据库校验失败");
    await this.create("pre_restore");
    this.store.replaceFrom(databaseFile);
    await this.copyOptionalDirectory(join(directory, "schedule-sources"), this.scheduleSourceDirectory);
    if (this.memberSourceDirectory) await this.copyOptionalDirectory(join(directory, "member-sources"), this.memberSourceDirectory);
  }

  async restoreManaged(directory: string): Promise<void> {
    const root = await realpath(this.currentRoot());
    const target = await realpath(directory);
    const relativePath = relative(root, target);
    if (!relativePath || relativePath.startsWith("..") || resolve(root, relativePath) !== target) {
      throw new Error("只能恢复当前备份目录中的备份");
    }
    await this.restore(target);
  }

  async list(): Promise<BackupEntry[]> {
    const backupRoot = this.currentRoot();
    await mkdir(backupRoot, { recursive: true });
    const root = await realpath(backupRoot);
    const entries = await readdir(root, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name));
    return Promise.all(
      directories.map(async (entry) => {
        const path = join(root, entry.name);
        const directoryStat = await stat(path);
        const inferredKind: BackupEntry["kind"] = entry.name.startsWith("daily_")
          ? "daily"
          : entry.name.startsWith("pre_restore_")
            ? "pre_restore"
            : "manual";
        try {
          const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8")) as BackupManifest;
          const databaseFile = join(path, manifest.databaseFile);
          const database = await readFile(databaseFile);
          const valid = [1, 2].includes(manifest.version)
            && manifest.databaseFile === "app.sqlite3"
            && createHash("sha256").update(database).digest("hex") === manifest.databaseSha256;
          return {
            name: entry.name,
            path,
            createdAt: manifest.createdAt,
            kind: manifest.kind,
            sizeBytes: database.byteLength,
            valid,
          };
        } catch {
          return {
            name: entry.name,
            path,
            createdAt: directoryStat.mtime.toISOString(),
            kind: inferredKind,
            sizeBytes: 0,
            valid: false,
          };
        }
      }),
    );
  }

  private async copyOptionalDirectory(source: string, destination: string): Promise<void> {
    try {
      if ((await stat(source)).isDirectory()) await cp(source, destination, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async retainLatest(count: number): Promise<void> {
    const backupRoot = this.currentRoot();
    await mkdir(backupRoot, { recursive: true });
    const root = await realpath(backupRoot);
    const entries = await readdir(root, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of directories.slice(count)) {
      const target = resolve(root, name);
      if (relative(root, target).startsWith("..") || basename(target) !== name) throw new Error("拒绝删除备份目录外的路径");
      await rm(target, { recursive: true, force: false });
    }
  }

  private currentRoot(): string {
    return typeof this.backupRoot === "function" ? this.backupRoot() : this.backupRoot;
  }
}
