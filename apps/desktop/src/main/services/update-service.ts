import type { UpdateInfo } from "electron-updater";
import { autoUpdater } from "electron-updater";
import type { UpdateMode, UpdateState } from "../../shared/contracts";
import type { SettingsService } from "./settings-service";

export interface UpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export class UpdateService {
  private stateValue: UpdateState;
  private notify: (state: UpdateState) => void = () => undefined;

  constructor(
    private readonly settings: SettingsService,
    options: {
      packaged: boolean;
      platform: NodeJS.Platform;
      currentVersion: string;
      adapter?: UpdaterAdapter;
    },
  ) {
    const supported = options.packaged && options.platform === "win32";
    this.stateValue = {
      supported,
      status: supported ? "idle" : "unsupported",
      currentVersion: options.currentVersion,
      availableVersion: null,
      progressPercent: null,
      message: supported ? "尚未检查更新" : "仅安装后的 Windows 版本支持更新",
    };
    if (!supported) return;
    const updater = options.adapter ?? autoUpdater;
    this.updater = updater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.on("checking-for-update", () => this.setState({ status: "checking", message: "正在检查更新…", progressPercent: null }));
    updater.on("update-available", (info: UpdateInfo) => {
      this.setState({ status: "available", availableVersion: info.version, message: `发现新版本 ${info.version}` });
      if (this.settings.getUpdates().mode === "automatic") void this.download();
    });
    updater.on("update-not-available", () => this.setState({ status: "upToDate", message: "当前已是最新版本", availableVersion: null }));
    updater.on("download-progress", (progress: { percent: number }) => this.setState({
      status: "downloading",
      progressPercent: Math.max(0, Math.min(100, progress.percent)),
      message: `正在下载更新 ${progress.percent.toFixed(0)}%`,
    }));
    updater.on("update-downloaded", (info: UpdateInfo) => this.setState({
      status: "downloaded",
      availableVersion: info.version,
      progressPercent: 100,
      message: `版本 ${info.version} 已下载，等待确认安装`,
    }));
    updater.on("error", (error: Error) => this.setState({
      status: "error",
      progressPercent: null,
      message: `更新失败：${error.message}`,
    }));
  }

  private updater: UpdaterAdapter | null = null;

  state(): UpdateState {
    return { ...this.stateValue };
  }

  setNotifier(notify: (state: UpdateState) => void): void {
    this.notify = notify;
  }

  mode(): { mode: UpdateMode } {
    return this.settings.getUpdates();
  }

  setMode(mode: UpdateMode): { mode: UpdateMode } {
    const value = this.settings.setUpdateMode(mode);
    if (mode === "automatic") void this.check();
    return value;
  }

  async startAutomaticCheck(): Promise<UpdateState> {
    if (this.settings.getUpdates().mode !== "automatic") return this.state();
    return this.check();
  }

  async check(): Promise<UpdateState> {
    if (!this.updater) return this.state();
    if (this.stateValue.status === "checking" || this.stateValue.status === "downloading") return this.state();
    this.setState({ status: "checking", message: "正在检查更新…", progressPercent: null });
    try {
      await this.updater.checkForUpdates();
    } catch (cause) {
      this.setState({ status: "error", message: `更新失败：${cause instanceof Error ? cause.message : String(cause)}` });
    }
    return this.state();
  }

  async download(): Promise<UpdateState> {
    if (!this.updater) return this.state();
    if (this.stateValue.status !== "available" && this.stateValue.status !== "error") {
      if (this.stateValue.status !== "downloading" && this.stateValue.status !== "downloaded") throw new Error("当前没有可下载的更新");
      return this.state();
    }
    this.setState({ status: "downloading", progressPercent: 0, message: "正在下载更新 0%" });
    try {
      await this.updater.downloadUpdate();
    } catch (cause) {
      this.setState({ status: "error", progressPercent: null, message: `下载失败：${cause instanceof Error ? cause.message : String(cause)}` });
    }
    return this.state();
  }

  install(): void {
    if (!this.updater || this.stateValue.status !== "downloaded") throw new Error("更新尚未下载完成");
    this.updater.quitAndInstall(false, true);
  }

  private setState(change: Partial<UpdateState>): void {
    this.stateValue = { ...this.stateValue, ...change };
    this.notify(this.state());
  }
}
