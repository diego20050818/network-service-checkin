import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const yaml = require("js-yaml");
const archiver = require("archiver");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
).version;
const directory = resolve(
  process.argv[2] ?? join(root, "apps/desktop/release", `candidate-${version}`),
);
const metadata = yaml.load(
  await readFile(join(directory, "latest.yml"), "utf8"),
);
const installer = `network-service-checkin-${version}-x64.exe`;
assert.equal(metadata.version, version);
assert.equal(metadata.path, installer);
assert.equal(metadata.files.length, 1);
assert.equal(metadata.files[0].url, installer);
const digest = async (path, algorithm, encoding = "hex") => {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
};
const sha512 = await digest(join(directory, installer), "sha512", "base64");
assert.equal(metadata.sha512, sha512);
assert.equal(metadata.files[0].sha512, sha512);
assert.equal(
  metadata.files[0].size,
  (await stat(join(directory, installer))).size,
);

const bundle = join(directory, "win-unpacked/resources/app.asar");
assert.equal(
  JSON.parse(asar.extractFile(bundle, "package.json").toString()).version,
  version,
);
const compare = [
  "dist/main/index.cjs",
  "dist/preload/index.cjs",
  "dist/renderer/index.html",
];
for (const name of await readdir(
  join(root, "apps/desktop/dist/renderer/assets"),
))
  compare.push("dist/renderer/assets/" + name);
for (const path of compare)
  assert.deepEqual(
    asar.extractFile(bundle, normalize(path)),
    await readFile(join(root, "apps/desktop", path)),
    `Bundle differs: ${path}`,
  );
const packagedUpdate = yaml.load(
  await readFile(
    join(directory, "win-unpacked/resources/app-update.yml"),
    "utf8",
  ),
);
assert.equal(packagedUpdate.provider, "github");
assert.equal(packagedUpdate.owner, "diego20050818");
assert.equal(packagedUpdate.repo, "network-service-checkin");

// Include the current working tree, including newly implemented files. Exclude
// runtime data, git metadata, dependency trees, old binaries and scratch files.
const paths = [
  ...new Set(
    execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root },
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  ),
]
  .filter(
    (p) =>
      /^(apps\/desktop\/(src\/|resources\/|scripts\/|[^/]+\.(json|ts)$)|scripts\/|tests\/(e2e\/|fixtures\/)|docs\/)/.test(
        p,
      ) ||
      [
        "package.json",
        "package-lock.json",
        "README.md",
        "CHANGELOG.md",
        "LICENSE",
        ".gitignore",
        "AGENTS(CLAUDE).md",
      ].includes(p),
  )
  .filter((p) => basename(p) !== "artifact-manifest.json")
  .sort();
const sourceName = `network-service-checkin-${version}-source.zip`;
await new Promise((resolveZip, reject) => {
  const output = createWriteStream(join(directory, sourceName));
  const zip = archiver("zip", { zlib: { level: 6 } });
  output.on("close", resolveZip);
  output.on("error", reject);
  zip.on("error", reject);
  zip.on("warning", reject);
  zip.pipe(output);
  for (const path of paths) zip.file(join(root, path), { name: path });
  void zip.finalize().catch(reject);
});
const files = [];
for (const name of [
  installer,
  installer + ".blockmap",
  "latest.yml",
  sourceName,
]) {
  const path = join(directory, name);
  files.push({
    name,
    size: (await stat(path)).size,
    sha256: await digest(path, "sha256"),
    sha512Base64: await digest(path, "sha512", "base64"),
  });
}
const result = {
  version,
  status: "candidate-not-published",
  verifiedAt: new Date().toISOString(),
  authenticode: process.argv[3] ?? "not-checked",
  latestMetadataMatches: true,
  packagedCodeMatchesBuild: true,
  updateChannelUnchanged: true,
  sourceFiles: paths.length,
  files,
};
await writeFile(
  join(directory, "artifact-manifest.json"),
  JSON.stringify(result, null, 2) + "\n",
);
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
