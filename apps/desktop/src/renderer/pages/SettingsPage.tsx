import { AppButton, AppInput, AppSelect, useFeedback } from "../ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BackupEntry,
  BootstrapData,
  SourceFileInfo,
  Settings,
  ShiftTimeKey,
  ShiftTimeSettings,
  StorageOverview,
  UpdateMode,
  UpdateState,
} from "../../shared/contracts";
import { registerNavigationGuard } from "../data/navigation";
import { PageHeader } from "../components";
import { errorMessage } from "../App";

const SHIFT_TIME_FIELDS: Array<{
  key: ShiftTimeKey;
  label: string;
  group: string;
}> = [
  { key: "weekdayDesk1", label: "工作日坐班 1", group: "工作日坐班" },
  { key: "weekdayDesk2", label: "工作日坐班 2", group: "工作日坐班" },
  { key: "weekdayDesk3", label: "工作日坐班 3", group: "工作日坐班" },
  { key: "weekdayDesk4", label: "工作日坐班 4", group: "工作日坐班" },
  { key: "maintenance", label: "维修班", group: "维修班" },
  { key: "weekendMorning", label: "周末上午", group: "周末坐班" },
  { key: "weekendAfternoon", label: "周末下午", group: "周末坐班" },
];

function paidTime(startTime: string, endTime: string): string {
  const toMinutes = (value: string) => {
    const [hour, minute] = value.split(":").map(Number);
    return hour! * 60 + minute!;
  };
  const value = Math.max(0, toMinutes(endTime) - toMinutes(startTime));
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${hours ? `${hours} 小时` : ""}${hours && minutes ? " " : ""}${minutes ? `${minutes} 分钟` : ""}`;
}

export function SettingsPage({
  data,
  onChanged,
}: {
  data: BootstrapData;
  onChanged(): Promise<void>;
}) {
  const { confirm } = useFeedback();
  const [settings, setSettings] = useState<Settings>(data.settings);
  const [shiftTimes, setShiftTimes] = useState<ShiftTimeSettings | null>(null);
  const [savedShiftTimes, setSavedShiftTimes] =
    useState<ShiftTimeSettings | null>(null);
  const [startup, setStartup] = useState(data.startup);
  const [storage, setStorage] = useState<StorageOverview | null>(null);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [updateMode, setUpdateMode] = useState<UpdateMode>(
    data.updateSettings.mode,
  );
  const [updateState, setUpdateState] = useState<UpdateState>(data.updateState);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(
    () =>
      registerNavigationGuard(async () => {
        const attendanceChanged =
          JSON.stringify(settings) !== JSON.stringify(data.settings);
        const shiftTimesChanged =
          shiftTimes !== null &&
          savedShiftTimes !== null &&
          JSON.stringify(shiftTimes) !== JSON.stringify(savedShiftTimes);
        if (!attendanceChanged && !shiftTimesChanged)
          return true;
        const discard = await confirm({
          title: "设置尚未保存",
          message: "可以留在页面保存，或放弃这些修改。",
          confirmLabel: "放弃修改",
          cancelLabel: "留在当前页面",
        });
        if (discard) {
          setSettings(data.settings);
          setShiftTimes(savedShiftTimes);
        }
        return discard;
      }),
    [settings, data.settings, shiftTimes, savedShiftTimes, confirm],
  );
  useEffect(() => setStartup(data.startup), [data.startup]);
  useEffect(() => {
    setUpdateMode(data.updateSettings.mode);
    setUpdateState(data.updateState);
  }, [data.updateSettings, data.updateState]);
  useEffect(() => window.checkinApi.onUpdateStateChanged(setUpdateState), []);

  const load = useCallback(async () => {
    try {
      const [overview, backupEntries, loadedShiftTimes] = await Promise.all([
        window.checkinApi.getStorageOverview(),
        window.checkinApi.listBackups(),
        window.checkinApi.getShiftTimeSettings(),
      ]);
      setStorage(overview);
      setBackups(backupEntries);
      setShiftTimes(loadedShiftTimes);
      setSavedShiftTimes(loadedShiftTimes);
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sourceFiles = useMemo(() => {
    if (!storage) return [];
    const values: Array<{
      type: string;
      file: SourceFileInfo | null;
      emptyText?: string;
    }> = storage.activeScheduleFiles.length
      ? storage.activeScheduleFiles.map((file) => ({ type: "当前排班", file }))
      : [{ type: "当前排班", file: null, emptyText: "尚未导入正式排班" }];
    values.push({
      type: "员工资料",
      file: storage.latestMemberFile,
      emptyText: data.members.length
        ? "旧版本未记录来源，请重新导入员工文件"
        : "尚未导入员工文件",
    });
    values.push(
      ...storage.templateFiles.map((file) => ({ type: file.detail, file })),
    );
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
      const overview =
        await window.checkinApi.chooseAndSetStorageDirectory(kind);
      if (!overview) return null;
      setStorage(overview);
      if (kind === "backup") setBackups(await window.checkinApi.listBackups());
      return kind === "output"
        ? "默认导出目录已更新"
        : "备份目录已更新，旧目录中的备份不会被移动";
    });
  }

  async function restore(path: string) {
    if (
      !(await confirm({
        title: "恢复备份",
        message:
          "将先验证备份并创建恢复前备份，再替换当前数据并重启。恢复后数据回到该备份时点。",
        confirmLabel: "恢复此备份",
      }))
    )
      return;
    await run("restore", async () =>
      (await window.checkinApi.restoreBackup(path)) ? "正在恢复并重启…" : null,
    );
  }

  async function restoreExternal() {
    if (
      !(await confirm({
        title: "从其他位置恢复",
        message: "选择备份目录后会先验证副本，恢复前自动备份当前数据。",
        confirmLabel: "选择备份",
      }))
    )
      return;
    await run("external-restore", async () =>
      (await window.checkinApi.chooseAndRestoreBackup())
        ? "正在恢复并重启…"
        : null,
    );
  }

  return (
    <div className="page-stack settings-page">
      <PageHeader title="设置" />
      {message && (
        <div className="success-banner" role="status">
          {message}
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}

      <section className="settings-section">
        <h2>签到与迟到</h2>
        <p>设置应用到尚未开始且没有签到历史的班次；历史记录不重算。</p>
        <div className="form-grid">
          <label>
            签到模式
            <AppSelect
              aria-label="签到模式"
              value={settings.attendanceMode}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  attendanceMode: e.target.value as Settings["attendanceMode"],
                })
              }
            >
              <option value="lenient">宽松模式</option>
              <option value="late_mark">迟到标记模式</option>
            </AppSelect>
          </label>
          <label>
            开班后多少分钟算迟到
            <AppInput
              type="number"
              aria-label="迟到阈值"
              min={0}
              max={180}
              value={settings.lateThresholdMinutes}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  lateThresholdMinutes: Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            每次迟到建议扣分
            <AppInput
              type="number"
              aria-label="建议扣分"
              min={0}
              max={30}
              step={0.5}
              value={settings.latePenaltyPoints}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  latePenaltyPoints: Number(e.target.value),
                })
              }
            />
          </label>
        </div>
        <AppButton
          disabled={Boolean(busy)}
          onClick={() =>
            run("attendance-settings", async () => {
              setSettings(await window.checkinApi.updateSettings(settings));
              try {
                await onChanged();
              } catch {
                return "设置已保存，但页面刷新失败";
              }
              return "签到设置已保存";
            })
          }
        >
          保存签到设置
        </AppButton>
      </section>
      <section className="settings-section">
        <h2>班次时段</h2>
        <p>
          修改模板使用的 7 条标准时段；工时按开始和结束时间自动计算。
          保存时只同步尚未开始、无签到历史且时间未被人工改动的正式班次。
        </p>
        {!shiftTimes ? (
          <div className="settings-loading">正在读取…</div>
        ) : (
          <div className="shift-time-grid">
            {SHIFT_TIME_FIELDS.map((field) => {
              const range = shiftTimes[field.key];
              return (
                <fieldset className="shift-time-card" key={field.key}>
                  <legend>{field.label}</legend>
                  <span>{field.group}</span>
                  <div className="shift-time-inputs">
                    <label>
                      开始
                      <AppInput
                        type="time"
                        aria-label={`${field.label}开始时间`}
                        value={range.startTime}
                        onChange={(event) =>
                          setShiftTimes({
                            ...shiftTimes,
                            [field.key]: {
                              ...range,
                              startTime: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      结束
                      <AppInput
                        type="time"
                        aria-label={`${field.label}结束时间`}
                        value={range.endTime}
                        onChange={(event) =>
                          setShiftTimes({
                            ...shiftTimes,
                            [field.key]: {
                              ...range,
                              endTime: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                  <small>计入工时：{paidTime(range.startTime, range.endTime)}</small>
                </fieldset>
              );
            })}
          </div>
        )}
        <AppButton
          disabled={Boolean(busy) || !shiftTimes}
          onClick={() =>
            shiftTimes &&
            run("shift-time-settings", async () => {
              const result =
                await window.checkinApi.updateShiftTimeSettings(shiftTimes);
              setShiftTimes(result.settings);
              setSavedShiftTimes(result.settings);
              try {
                await onChanged();
              } catch {
                return `班次时段已保存，同步 ${result.updatedShiftCount} 个正式班次，但页面刷新失败`;
              }
              return `班次时段已保存，同步 ${result.updatedShiftCount} 个正式班次`;
            })
          }
        >
          保存班次时段
        </AppButton>
      </section>
      <section className="settings-section">
        <div className="settings-section-heading">
          <h2>系统</h2>
        </div>
        <div className="settings-row">
          <div>
            <strong>开机自启动</strong>
            <span>
              {startup.supported
                ? "登录 Windows 后自动打开应用"
                : "仅安装后的 Windows 版本支持"}
            </span>
          </div>
          <AppInput
            type="checkbox"
            role="switch"
            aria-label="开机自启动"
            checked={startup.enabled}
            disabled={!startup.supported || Boolean(busy)}
            onChange={(event) => {
              const enabled = event.target.checked;
              void run("startup", async () => {
                const value =
                  await window.checkinApi.setStartupEnabled(enabled);
                setStartup(value);
                await onChanged();
                return enabled ? "已开启开机自启动" : "已关闭开机自启动";
              });
            }}
          />
        </div>
        <div className="settings-row update-settings-row">
          <div>
            <strong>应用更新</strong>
            <span>
              {updateState.message} · 当前版本 {updateState.currentVersion}
              {updateState.availableVersion
                ? ` · 可用版本 ${updateState.availableVersion}`
                : ""}
            </span>
            {updateState.status === "downloading" && (
              <progress value={updateState.progressPercent ?? 0} max={100}>
                {updateState.progressPercent ?? 0}%
              </progress>
            )}
          </div>
          <div className="update-controls">
            <AppSelect
              aria-label="更新模式"
              value={updateMode}
              disabled={!updateState.supported || Boolean(busy)}
              onChange={(event) => {
                const mode = event.target.value as UpdateMode;
                void run("update-mode", async () => {
                  const value = await window.checkinApi.setUpdateMode(mode);
                  setUpdateMode(value.mode);
                  await onChanged();
                  return mode === "automatic"
                    ? "已开启自动检查和后台下载"
                    : "已切换为手动更新";
                });
              }}
            >
              <option value="manual">手动更新</option>
              <option value="automatic">自动检查与下载</option>
            </AppSelect>
            <AppButton
              disabled={
                !updateState.supported ||
                Boolean(busy) ||
                updateState.status === "checking" ||
                updateState.status === "downloading"
              }
              onClick={() =>
                void run("update-check", async () => {
                  setUpdateState(await window.checkinApi.checkForUpdates());
                  return null;
                })
              }
            >
              检查更新
            </AppButton>
            {updateState.status === "available" && (
              <AppButton
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("update-download", async () => {
                    setUpdateState(await window.checkinApi.downloadUpdate());
                    return null;
                  })
                }
              >
                下载
              </AppButton>
            )}
            {updateState.status === "downloaded" && (
              <AppButton
                className="primary-button"
                disabled={Boolean(busy)}
                onClick={async () => {
                  if (
                    await confirm({
                      title: "安装更新",
                      message: "将先保存草稿，再重启安装。",
                      confirmLabel: "重启并安装",
                    })
                  )
                    await window.checkinApi.installUpdate();
                }}
              >
                重启并安装
              </AppButton>
            )}
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <h2>文件存放位置</h2>
        </div>
        {!storage ? (
          <div className="settings-loading">正在读取…</div>
        ) : (
          <>
            <DirectoryRow
              label="应用数据"
              description="数据库、导入文件副本及内部数据"
              path={storage.dataDirectory}
              onOpen={() => void window.checkinApi.openDataDirectory()}
            />
            <DirectoryRow
              label="默认导出目录"
              description="新月份的月报默认保存位置"
              path={storage.settings.defaultOutputDirectory}
              onChoose={() => void chooseDirectory("output")}
              onOpen={() =>
                void window.checkinApi.openPath(
                  storage.settings.defaultOutputDirectory,
                )
              }
              disabled={Boolean(busy)}
            />
            <DirectoryRow
              label="备份目录"
              description="自动备份、手动备份和恢复前备份"
              path={storage.settings.backupDirectory}
              onChoose={() => void chooseDirectory("backup")}
              onOpen={() =>
                void window.checkinApi.openPath(
                  storage.settings.backupDirectory,
                )
              }
              disabled={Boolean(busy)}
            />
            <DirectoryRow
              label="模板目录"
              description="当前版本随包提供的导入和输出模板"
              path={storage.templateDirectory}
              onOpen={() =>
                void window.checkinApi.openPath(storage.templateDirectory)
              }
            />
          </>
        )}
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h2>当前使用的文件</h2>
            <p>排班和员工文件在导入时复制到应用数据目录。</p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="settings-file-table">
            <thead>
              <tr>
                <th>用途</th>
                <th>文件</th>
                <th>信息</th>
                <th>导入/更新时间</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sourceFiles.map(({ type, file, emptyText }) => (
                <tr key={`${type}-${file?.path ?? "empty"}`}>
                  <td>{type}</td>
                  <td>
                    {file ? (
                      <>
                        <strong>{file.name}</strong>
                        <small className="path-text">{file.path}</small>
                      </>
                    ) : (
                      <span className="muted-value">{emptyText}</span>
                    )}
                  </td>
                  <td>{file?.detail ?? "—"}</td>
                  <td>{file ? formatDateTime(file.importedAt) : "—"}</td>
                  <td>
                    {file ? (
                      <span
                        className={`file-state ${file.exists ? "ok" : "missing"}`}
                      >
                        <i />
                        {file.exists ? "可用" : "缺失"}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <AppButton
                      className="text-button"
                      disabled={!file?.exists}
                      onClick={() =>
                        file && void window.checkinApi.openPath(file.path)
                      }
                    >
                      打开
                    </AppButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading settings-backup-heading">
          <div>
            <h2>备份管理</h2>
            <p>
              每日首次启动自动备份，最多保留最近 30 份；恢复前自动再备份一次。
            </p>
          </div>
          <div className="button-row compact-row">
            <AppButton
              className="secondary-button"
              disabled={Boolean(busy)}
              onClick={() =>
                void run("backup", async () => {
                  const path = await window.checkinApi.createBackup();
                  setBackups(await window.checkinApi.listBackups());
                  return `备份完成：${path}`;
                })
              }
            >
              立即备份
            </AppButton>
            <AppButton
              className="secondary-button"
              disabled={Boolean(busy)}
              onClick={() =>
                storage &&
                void window.checkinApi.openPath(
                  storage.settings.backupDirectory,
                )
              }
            >
              打开备份目录
            </AppButton>
            <AppButton
              className="text-button"
              disabled={Boolean(busy)}
              onClick={() => void restoreExternal()}
            >
              从其他位置恢复
            </AppButton>
          </div>
        </div>
        <div className="table-scroll">
          <table className="settings-backup-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>数据库大小</th>
                <th>校验</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {backups.length === 0 ? (
                <tr>
                  <td colSpan={5} className="settings-empty-row">
                    当前目录还没有备份
                  </td>
                </tr>
              ) : (
                backups.map((backup) => (
                  <tr key={backup.path}>
                    <td>{formatDateTime(backup.createdAt)}</td>
                    <td>{backupKindLabel(backup.kind)}</td>
                    <td>{formatBytes(backup.sizeBytes)}</td>
                    <td>
                      <span
                        className={`file-state ${backup.valid ? "ok" : "missing"}`}
                      >
                        <i />
                        {backup.valid ? "完整" : "损坏"}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <AppButton
                          disabled={!backup.valid || Boolean(busy)}
                          onClick={() => void restore(backup.path)}
                        >
                          恢复
                        </AppButton>
                        <AppButton
                          onClick={() =>
                            void window.checkinApi.openPath(backup.path)
                          }
                        >
                          打开
                        </AppButton>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function DirectoryRow({
  label,
  description,
  path,
  onChoose,
  onOpen,
  disabled = false,
}: {
  label: string;
  description: string;
  path: string;
  onChoose?: () => void;
  onOpen: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="settings-directory-row">
      <div>
        <strong>{label}</strong>
        <span>{description}</span>
      </div>
      <code title={path}>{path}</code>
      <div className="row-actions">
        {onChoose && (
          <AppButton disabled={disabled} onClick={onChoose}>
            更改
          </AppButton>
        )}
        <AppButton onClick={onOpen}>打开</AppButton>
      </div>
    </div>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}

function backupKindLabel(kind: BackupEntry["kind"]): string {
  return kind === "daily"
    ? "每日自动"
    : kind === "pre_restore"
      ? "恢复前"
      : "手动";
}

function formatBytes(value: number): string {
  if (!value) return "—";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
