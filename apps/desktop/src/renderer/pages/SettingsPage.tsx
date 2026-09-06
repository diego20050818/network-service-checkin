import { useCallback, useEffect, useMemo, useState } from "react";
import type { BackupEntry, BootstrapData, SourceFileInfo, StorageOverview } from "../../shared/contracts";
import { PageHeader } from "../components";
import { errorMessage } from "../App";

export function SettingsPage({ data, onChanged }: { data: BootstrapData; onChanged(): Promise<void> }) {
  const [startup, setStartup] = useState(data.startup);
  const [storage, setStorage] = useState<StorageOverview | null>(null);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => setStartup(data.startup), [data.startup]);

  const load = useCallback(async () => {
    try {
      const [overview, backupEntries] = await Promise.all([
        window.checkinApi.getStorageOverview(),
        window.checkinApi.listBackups(),
      ]);
      setStorage(overview);
      setBackups(backupEntries);
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const sourceFiles = useMemo(() => {
    if (!storage) return [];
    const values: Array<{ type: string; file: SourceFileInfo | null; emptyText?: string }> = storage.activeScheduleFiles.length
      ? storage.activeScheduleFiles.map((file) => ({ type: "当前排班", file }))
      : [{ type: "当前排班", file: null, emptyText: "尚未导入正式排班" }];
    values.push({ type: "员工资料", file: storage.latestMemberFile, emptyText: data.members.length ? "旧版本未记录来源，请重新导入员工文件" : "尚未导入员工文件" });
    values.push(...storage.templateFiles.map((file) => ({ type: file.detail, file })));
    return values;
  }, [data.members.length, storage]);

  async function run(label: string, action: () => Promise<string | null>) {
    setBusy(label);
    setMessage("");
    setError("");
    try {
      const result = await action();
      if (result) setMessage(result);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }

  async function chooseDirectory(kind: "output" | "backup") {
    await run(`directory-${kind}`, async () => {
      const overview = await window.checkinApi.chooseAndSetStorageDirectory(kind);
      if (!overview) return null;
      setStorage(overview);
      if (kind === "backup") setBackups(await window.checkinApi.listBackups());
      return kind === "output" ? "默认导出目录已更新" : "备份目录已更新，旧目录中的备份不会被移动";
    });
  }

  async function restore(path: string) {
    if (!window.confirm("恢复会替换当前数据库；系统会先创建一份恢复前备份，然后重启应用。是否继续？")) return;
    await run("restore", async () => (await window.checkinApi.restoreBackup(path)) ? "正在恢复并重启…" : null);
  }

  async function restoreExternal() {
    if (!window.confirm("请选择可信的备份目录。恢复会替换当前数据库，并在操作前自动创建安全备份。是否继续？")) return;
    await run("external-restore", async () => (await window.checkinApi.chooseAndRestoreBackup()) ? "正在恢复并重启…" : null);
  }

  return (
    <div className="page-stack settings-page">
      <PageHeader title="设置" />
      {message && <div className="success-banner" role="status">{message}</div>}
      {error && <div className="inline-error" role="alert">{error}</div>}

      <section className="settings-section">
        <div className="settings-section-heading"><h2>系统</h2></div>
        <div className="settings-row">
          <div><strong>开机自启动</strong><span>{startup.supported ? "登录 Windows 后自动打开应用" : "仅安装后的 Windows 版本支持"}</span></div>
          <input
            type="checkbox"
            role="switch"
            aria-label="开机自启动"
            checked={startup.enabled}
            disabled={!startup.supported || Boolean(busy)}
            onChange={(event) => {
              const enabled = event.target.checked;
              void run("startup", async () => {
                const value = await window.checkinApi.setStartupEnabled(enabled);
                setStartup(value);
                await onChanged();
                return enabled ? "已开启开机自启动" : "已关闭开机自启动";
              });
            }}
          />
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading"><h2>文件存放位置</h2></div>
        {!storage ? <div className="settings-loading">正在读取…</div> : <>
          <DirectoryRow label="应用数据" description="数据库、导入文件副本及内部数据" path={storage.dataDirectory} onOpen={() => void window.checkinApi.openDataDirectory()} />
          <DirectoryRow label="默认导出目录" description="新月份的月报默认保存位置" path={storage.settings.defaultOutputDirectory} onChoose={() => void chooseDirectory("output")} onOpen={() => void window.checkinApi.openPath(storage.settings.defaultOutputDirectory)} disabled={Boolean(busy)} />
          <DirectoryRow label="备份目录" description="自动备份、手动备份和恢复前备份" path={storage.settings.backupDirectory} onChoose={() => void chooseDirectory("backup")} onOpen={() => void window.checkinApi.openPath(storage.settings.backupDirectory)} disabled={Boolean(busy)} />
          <DirectoryRow label="模板目录" description="当前版本随包提供的导入和输出模板" path={storage.templateDirectory} onOpen={() => void window.checkinApi.openPath(storage.templateDirectory)} />
        </>}
      </section>

      <section className="settings-section">
        <div className="settings-section-heading"><div><h2>当前使用的文件</h2><p>排班和员工文件在导入时复制到应用数据目录。</p></div></div>
        <div className="table-scroll">
          <table className="settings-file-table">
            <thead><tr><th>用途</th><th>文件</th><th>信息</th><th>导入/更新时间</th><th>状态</th><th /></tr></thead>
            <tbody>
              {sourceFiles.map(({ type, file, emptyText }) => (
                <tr key={`${type}-${file?.path ?? "empty"}`}>
                  <td>{type}</td>
                  <td>{file ? <><strong>{file.name}</strong><small className="path-text">{file.path}</small></> : <span className="muted-value">{emptyText}</span>}</td>
                  <td>{file?.detail ?? "—"}</td>
                  <td>{file ? formatDateTime(file.importedAt) : "—"}</td>
                  <td>{file ? <span className={`file-state ${file.exists ? "ok" : "missing"}`}><i />{file.exists ? "可用" : "缺失"}</span> : "—"}</td>
                  <td><button className="text-button" disabled={!file?.exists} onClick={() => file && void window.checkinApi.openPath(file.path)}>打开</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading settings-backup-heading">
          <div><h2>备份管理</h2><p>每日首次启动自动备份，最多保留最近 30 份；恢复前自动再备份一次。</p></div>
          <div className="button-row compact-row">
            <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void run("backup", async () => { const path = await window.checkinApi.createBackup(); setBackups(await window.checkinApi.listBackups()); return `备份完成：${path}`; })}>立即备份</button>
            <button className="secondary-button" disabled={Boolean(busy)} onClick={() => storage && void window.checkinApi.openPath(storage.settings.backupDirectory)}>打开备份目录</button>
            <button className="text-button" disabled={Boolean(busy)} onClick={() => void restoreExternal()}>从其他位置恢复</button>
          </div>
        </div>
        <div className="table-scroll">
          <table className="settings-backup-table">
            <thead><tr><th>时间</th><th>类型</th><th>数据库大小</th><th>校验</th><th /></tr></thead>
            <tbody>
              {backups.length === 0 ? <tr><td colSpan={5} className="settings-empty-row">当前目录还没有备份</td></tr> : backups.map((backup) => (
                <tr key={backup.path}>
                  <td>{formatDateTime(backup.createdAt)}</td>
                  <td>{backupKindLabel(backup.kind)}</td>
                  <td>{formatBytes(backup.sizeBytes)}</td>
                  <td><span className={`file-state ${backup.valid ? "ok" : "missing"}`}><i />{backup.valid ? "完整" : "损坏"}</span></td>
                  <td><div className="row-actions"><button disabled={!backup.valid || Boolean(busy)} onClick={() => void restore(backup.path)}>恢复</button><button onClick={() => void window.checkinApi.openPath(backup.path)}>打开</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function DirectoryRow({ label, description, path, onChoose, onOpen, disabled = false }: {
  label: string;
  description: string;
  path: string;
  onChoose?: () => void;
  onOpen: () => void;
  disabled?: boolean;
}) {
  return <div className="settings-directory-row">
    <div><strong>{label}</strong><span>{description}</span></div>
    <code title={path}>{path}</code>
    <div className="row-actions">
      {onChoose && <button disabled={disabled} onClick={onChoose}>更改</button>}
      <button onClick={onOpen}>打开</button>
    </div>
  </div>;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function backupKindLabel(kind: BackupEntry["kind"]): string {
  return kind === "daily" ? "每日自动" : kind === "pre_restore" ? "恢复前" : "手动";
}

function formatBytes(value: number): string {
  if (!value) return "—";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
