import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
export type FileManifest = Record<string, string>;
export async function hashFiles(directory: string): Promise<FileManifest> {
  const result: FileManifest = {};
  async function walk(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("备份目录不能包含符号链接");
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name !== "manifest.json")
        result[relative(directory, path).replaceAll("\\", "/")] = createHash(
          "sha256",
        )
          .update(await readFile(path))
          .digest("hex");
    }
  }
  await walk(directory);
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
  );
}
export async function verifyFiles(
  directory: string,
  files: FileManifest,
): Promise<void> {
  for (const [name, digest] of Object.entries(files)) {
    const path = resolve(directory, name);
    const rel = relative(resolve(directory), path);
    if (!rel || rel.startsWith("..") || resolve(directory, rel) !== path)
      throw new Error("备份清单包含无效路径");
    if (
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex") !== digest
    )
      throw new Error("备份文件校验失败：" + name);
  }
}
