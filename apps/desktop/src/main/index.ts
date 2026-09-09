import {
  app,
  BrowserWindow,
  session,
  ipcMain,
  dialog,
  Notification,
} from "electron";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { DatabaseStore } from "./database";
import {
  registerIpcHandlers,
  removeIpcHandlers,
  type ServiceContext,
} from "./ipc";
import { AttendanceService } from "./services/attendance-service";
import { AdjustmentService } from "./services/adjustment-service";
import { BackupService } from "./services/backup-service";
import { DashboardService } from "./services/dashboard-service";
import { MemberService } from "./services/member-service";
import { ReportService } from "./services/report-service";
import { ScheduleService } from "./services/schedule-service";
import { SettingsService } from "./services/settings-service";
import { StartupService } from "./services/startup-service";
import { StorageService } from "./services/storage-service";
import { UpdateService } from "./services/update-service";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { prepareUpgrade } from "./upgrade";
import {
  AttendanceReminderService,
  deliverAttendanceReminder,
} from "./services/attendance-reminder-service";

let mainWindow: BrowserWindow | null = null;
let services: ServiceContext | null = null;
let attendanceReminders: AttendanceReminderService | null = null;
let closeAuthorized = false;
let closeRequest: {
  id: string;
  promise: Promise<boolean>;
  finish(value: boolean): void;
} | null = null;
function requestSavedClose(): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(true);
  if (closeRequest) return closeRequest.promise;
  let finish!: (value: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const id = randomUUID();
  closeRequest = { id, promise, finish };
  const timer = setTimeout(() => {
    if (closeRequest?.id === id) closeRequest.finish(false);
  }, 30_000);
  mainWindow.webContents.send(IPC_CHANNELS.closeRequested, id);
  return promise.finally(() => {
    clearTimeout(timer);
    closeRequest = null;
  });
}

if (process.env.NODE_ENV === "test") app.disableHardwareAcceleration();

async function createServices(): Promise<ServiceContext> {
  const dataDirectory = join(app.getPath("userData"), "data");
  const scheduleSourceDirectory = join(dataDirectory, "schedule-sources");
  const memberSourceDirectory = join(dataDirectory, "member-sources");
  const backupDirectory = join(dataDirectory, "backups");
  const defaultOutputDirectory = join(dataDirectory, "exports");
  const templateDirectory = app.isPackaged
    ? join(process.resourcesPath, "templates")
    : resolve(app.getAppPath(), "resources", "templates");
  await Promise.all([
    mkdir(dataDirectory, { recursive: true }),
    mkdir(scheduleSourceDirectory, { recursive: true }),
    mkdir(memberSourceDirectory, { recursive: true }),
    mkdir(backupDirectory, { recursive: true }),
    mkdir(defaultOutputDirectory, { recursive: true }),
  ]);
  await prepareUpgrade(dataDirectory, templateDirectory);
  const store = new DatabaseStore(join(dataDirectory, "app.sqlite3"));
  const members = new MemberService(store, memberSourceDirectory);
  const settings = new SettingsService(store, {
    defaultOutputDirectory,
    backupDirectory,
  });
  const startup = new StartupService({
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: process.execPath,
    getLoginItemSettings: (options) => app.getLoginItemSettings(options),
    setLoginItemSettings: (options) => app.setLoginItemSettings(options),
  });
  const attendance = new AttendanceService(store, members);
  const adjustments = new AdjustmentService(store, members, attendance);
  const dashboard = new DashboardService(store, attendance, members);
  const schedule = new ScheduleService(store, members, scheduleSourceDirectory);
  const reports = new ReportService(
    store,
    dashboard,
    members,
    settings,
    templateDirectory,
  );
  const backup = new BackupService(
    store,
    () => settings.getStorage().backupDirectory,
    templateDirectory,
    scheduleSourceDirectory,
    memberSourceDirectory,
  );
  const storage = new StorageService(store, settings, {
    dataDirectory,
    templateDirectory,
    scheduleSourceDirectory,
    memberSourceDirectory,
  });
  const updates = new UpdateService(settings, {
    packaged: app.isPackaged,
    platform: process.platform,
    currentVersion: app.getVersion(),
  });
  return {
    store,
    members,
    settings,
    startup,
    attendance,
    adjustments,
    dashboard,
    schedule,
    reports,
    backup,
    storage,
    updates,
    dataDirectory,
    templateDirectory,
    beforeInstall: requestSavedClose,
  };
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 540,
    show: false,
    backgroundColor: "#F7F6F2",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.on("close", (event) => {
    if (closeAuthorized) return;
    event.preventDefault();
    void requestSavedClose().then((allowed) => {
      if (allowed) {
        closeAuthorized = true;
        mainWindow?.close();
      }
    });
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed =
      process.env.VITE_DEV_SERVER_URL &&
      url.startsWith(process.env.VITE_DEV_SERVER_URL);
    if (!allowed && !url.startsWith("file://")) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("focus", () => mainWindow?.flashFrame(false));
  if (process.env.VITE_DEV_SERVER_URL)
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

app
  .whenReady()
  .then(async () => {
    session.defaultSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    services = await createServices();
    services.updates.setNotifier((state) =>
      mainWindow?.webContents.send(IPC_CHANNELS.updateStateChanged, state),
    );
    registerIpcHandlers(services);
    ipcMain.handle(IPC_CHANNELS.closeResponse, (event, id, allowed) => {
      if (
        event.sender !== mainWindow?.webContents ||
        id !== closeRequest?.id ||
        typeof allowed !== "boolean"
      )
        throw new Error("无效的关闭响应");
      closeRequest!.finish(allowed);
    });
    await services.backup
      .ensureDaily()
      .catch((error) => console.error("每日备份失败", error));
    await createWindow();
    attendanceReminders = new AttendanceReminderService(
      services.store,
      services.attendance,
      (payload) =>
        deliverAttendanceReminder(payload, {
          send: (value) =>
            mainWindow?.webContents.send(IPC_CHANNELS.attendanceReminder, value),
          isForeground: () =>
            Boolean(
              mainWindow?.isVisible() &&
                !mainWindow.isMinimized() &&
                mainWindow.isFocused(),
            ),
          showSystemNotification: (title, body, onClick) => {
            const notification = new Notification({ title, body });
            notification.once("click", onClick);
            notification.show();
          },
          flashTaskbar: () => mainWindow?.flashFrame(true),
          restoreWindow: () => {
            if (!mainWindow) return;
            if (mainWindow.isMinimized()) mainWindow.restore();
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
          },
        }),
    );
    if (process.env.NODE_ENV !== "test") attendanceReminders.start();
    setTimeout(() => {
      void services?.updates.startAutomaticCheck();
    }, 3_000);
    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) await createWindow();
    });
  })
  .catch((error) => {
    dialog.showErrorBox(
      "升级未完成，原数据已保留",
      error instanceof Error ? error.message : String(error),
    );
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (!closeAuthorized && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault();
    void requestSavedClose().then((allowed) => {
      if (allowed) {
        closeAuthorized = true;
        app.quit();
      }
    });
    return;
  }
  removeIpcHandlers();
  attendanceReminders?.stop();
  attendanceReminders = null;
  services?.store.close();
  services = null;
});
