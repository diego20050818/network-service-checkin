import { describe, expect, it, vi } from "vitest";
import { StartupService, type StartupRuntime } from "./startup-service";

function runtime(overrides: Partial<StartupRuntime> = {}): StartupRuntime {
  let enabled = false;
  return {
    platform: "win32",
    isPackaged: true,
    executablePath: "C:\\Program Files\\Checkin\\checkin.exe",
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: enabled, executableWillLaunchAtLogin: enabled })),
    setLoginItemSettings: vi.fn((settings) => { enabled = settings.openAtLogin && settings.enabled; }),
    ...overrides,
  };
}

describe("StartupService", () => {
  it("在已打包 Windows 应用中启用和关闭开机自启动", () => {
    const adapter = runtime();
    const service = new StartupService(adapter);
    expect(service.get()).toEqual({ supported: true, enabled: false });
    expect(service.setEnabled(true).enabled).toBe(true);
    expect(service.setEnabled(false).enabled).toBe(false);
    expect(adapter.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      enabled: true,
      path: adapter.executablePath,
    });
  });

  it("开发模式不修改 Windows 登录项", () => {
    const adapter = runtime({ isPackaged: false });
    const service = new StartupService(adapter);
    expect(service.get()).toEqual({ supported: false, enabled: false });
    expect(() => service.setEnabled(true)).toThrow("已安装的 Windows 版本");
    expect(adapter.setLoginItemSettings).not.toHaveBeenCalled();
  });
});
