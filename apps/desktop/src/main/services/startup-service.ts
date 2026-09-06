import type { StartupSettings } from "../../shared/contracts";

export interface StartupRuntime {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  executablePath: string;
  getLoginItemSettings(options: { path: string }): {
    openAtLogin: boolean;
    executableWillLaunchAtLogin: boolean;
  };
  setLoginItemSettings(settings: { openAtLogin: boolean; enabled: boolean; path: string }): void;
}

export class StartupService {
  constructor(private readonly runtime: StartupRuntime) {}

  get(): StartupSettings {
    const supported = this.runtime.platform === "win32" && this.runtime.isPackaged;
    if (!supported) return { supported: false, enabled: false };
    const state = this.runtime.getLoginItemSettings({ path: this.runtime.executablePath });
    return {
      supported: true,
      enabled: state.openAtLogin && state.executableWillLaunchAtLogin,
    };
  }

  setEnabled(enabled: boolean): StartupSettings {
    if (!this.get().supported) throw new Error("开机自启动只能在已安装的 Windows 版本中设置");
    this.runtime.setLoginItemSettings({
      openAtLogin: enabled,
      enabled,
      path: this.runtime.executablePath,
    });
    const current = this.get();
    if (current.enabled !== enabled) throw new Error("Windows 未确认开机自启动设置，请在系统启动应用设置中检查");
    return current;
  }
}
