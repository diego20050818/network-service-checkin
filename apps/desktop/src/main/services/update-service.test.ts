import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseStore } from "../database";
import { SettingsService } from "./settings-service";
import { UpdateService, type UpdaterAdapter } from "./update-service";

class FakeUpdater implements UpdaterAdapter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  checks = 0;
  downloads = 0;
  installs = 0;
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  async checkForUpdates(): Promise<void> {
    this.checks += 1;
    this.emit("checking-for-update");
    this.emit("update-available", { version: "0.5.1" });
  }

  async downloadUpdate(): Promise<void> {
    this.downloads += 1;
    this.emit("download-progress", { percent: 52 });
    this.emit("update-downloaded", { version: "0.5.1" });
  }

  quitAndInstall(): void { this.installs += 1; }

  private emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

describe("UpdateService", () => {
  let store: DatabaseStore;
  let settings: SettingsService;

  beforeEach(() => {
    store = new DatabaseStore(":memory:");
    settings = new SettingsService(store);
  });
  afterEach(() => store.close());

  it("默认手动且开发版不访问更新适配器", async () => {
    const adapter = new FakeUpdater();
    const service = new UpdateService(settings, { packaged: false, platform: "win32", currentVersion: "0.5.0", adapter });
    expect(service.mode()).toEqual({ mode: "manual" });
    expect((await service.check()).status).toBe("unsupported");
    expect(adapter.checks).toBe(0);
  });

  it("手动检查、下载，并只在确认后调用安装", async () => {
    const adapter = new FakeUpdater();
    const service = new UpdateService(settings, { packaged: true, platform: "win32", currentVersion: "0.5.0", adapter });
    expect(adapter.autoDownload).toBe(false);
    expect((await service.check()).status).toBe("available");
    expect(adapter.downloads).toBe(0);
    expect((await service.download()).status).toBe("downloaded");
    expect(service.state().progressPercent).toBe(100);
    service.install();
    expect(adapter.installs).toBe(1);
  });

  it("自动模式启动检查并后台下载", async () => {
    settings.setUpdateMode("automatic");
    const adapter = new FakeUpdater();
    const service = new UpdateService(settings, { packaged: true, platform: "win32", currentVersion: "0.5.0", adapter });
    await service.startAutomaticCheck();
    await Promise.resolve();
    expect(adapter.checks).toBe(1);
    expect(adapter.downloads).toBe(1);
    expect(service.state().status).toBe("downloaded");
  });
});
