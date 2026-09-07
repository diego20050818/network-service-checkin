import { contextBridge, ipcRenderer } from "electron";
import type { CheckinApi } from "../shared/contracts";
import { IPC_CHANNELS } from "../shared/ipc-channels";

const api: CheckinApi = {
  bootstrap: (now) => ipcRenderer.invoke(IPC_CHANNELS.bootstrap, now),
  getCurrentShifts: (now) => ipcRenderer.invoke(IPC_CHANNELS.currentShifts, now),
  getShiftsForDate: (date) => ipcRenderer.invoke(IPC_CHANNELS.shiftsForDate, date),
  checkIn: (shiftId, selections, now) => ipcRenderer.invoke(IPC_CHANNELS.checkIn, shiftId, selections, now),
  listRecords: (filters) => ipcRenderer.invoke(IPC_CHANNELS.records, filters),
  correctRecord: (recordId, memberId) => ipcRenderer.invoke(IPC_CHANNELS.correctRecord, recordId, memberId),
  revokeRecord: (recordId) => ipcRenderer.invoke(IPC_CHANNELS.revokeRecord, recordId),
  restoreRecord: (recordId) => ipcRenderer.invoke(IPC_CHANNELS.restoreRecord, recordId),
  addManualAttendance: (input) => ipcRenderer.invoke(IPC_CHANNELS.manualRecord, input),
  getDashboard: (filters) => ipcRenderer.invoke(IPC_CHANNELS.dashboard, filters),
  listLeaves: (filters) => ipcRenderer.invoke(IPC_CHANNELS.leaves, filters),
  createLeave: (input) => ipcRenderer.invoke(IPC_CHANNELS.createLeave, input),
  updateLeave: (leaveId, input) => ipcRenderer.invoke(IPC_CHANNELS.updateLeave, leaveId, input),
  cancelLeave: (leaveId) => ipcRenderer.invoke(IPC_CHANNELS.cancelLeave, leaveId),
  addShiftStaff: (input) => ipcRenderer.invoke(IPC_CHANNELS.addShiftStaff, input),
  removeShiftStaff: (slotId) => ipcRenderer.invoke(IPC_CHANNELS.removeShiftStaff, slotId),
  listOvertime: (filters) => ipcRenderer.invoke(IPC_CHANNELS.overtime, filters),
  createOvertime: (input) => ipcRenderer.invoke(IPC_CHANNELS.createOvertime, input),
  cancelOvertime: (slotId) => ipcRenderer.invoke(IPC_CHANNELS.cancelOvertime, slotId),
  chooseAndImportSchedule: (input) => ipcRenderer.invoke(IPC_CHANNELS.importSchedule, input),
  saveImportTemplate: (kind) => ipcRenderer.invoke(IPC_CHANNELS.saveImportTemplate, kind),
  chooseAndImportMembers: () => ipcRenderer.invoke(IPC_CHANNELS.importMembers),
  listMembers: () => ipcRenderer.invoke(IPC_CHANNELS.members),
  saveMember: (member) => ipcRenderer.invoke(IPC_CHANNELS.saveMember, member),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settings),
  updateSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.updateSettings, settings),
  getUpdateSettings: () => ipcRenderer.invoke(IPC_CHANNELS.updateMode),
  setUpdateMode: (mode) => ipcRenderer.invoke(IPC_CHANNELS.setUpdateMode, mode),
  getUpdateState: () => ipcRenderer.invoke(IPC_CHANNELS.updateState),
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.checkUpdate),
  downloadUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.installUpdate),
  onUpdateStateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on(IPC_CHANNELS.updateStateChanged, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.updateStateChanged, handler);
  },
  getStartupSettings: () => ipcRenderer.invoke(IPC_CHANNELS.startupSettings),
  setStartupEnabled: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.setStartupEnabled, enabled),
  getStorageOverview: () => ipcRenderer.invoke(IPC_CHANNELS.storageOverview),
  chooseAndSetStorageDirectory: (kind) => ipcRenderer.invoke(IPC_CHANNELS.chooseStorageDirectory, kind),
  getReportDraft: (year, month) => ipcRenderer.invoke(IPC_CHANNELS.reportDraft, year, month),
  saveReportDraft: (draft) => ipcRenderer.invoke(IPC_CHANNELS.saveReportDraft, draft),
  previewReports: (draft) => ipcRenderer.invoke(IPC_CHANNELS.previewReports, draft),
  chooseOutputDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chooseOutput),
  exportReports: (draft) => ipcRenderer.invoke(IPC_CHANNELS.exportReports, draft),
  openPath: (path) => ipcRenderer.invoke(IPC_CHANNELS.openPath, path),
  openDataDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.openData),
  createBackup: () => ipcRenderer.invoke(IPC_CHANNELS.backup),
  listBackups: () => ipcRenderer.invoke(IPC_CHANNELS.backups),
  restoreBackup: (path) => ipcRenderer.invoke(IPC_CHANNELS.restoreManagedBackup, path),
  chooseAndRestoreBackup: () => ipcRenderer.invoke(IPC_CHANNELS.restoreBackup),
};

contextBridge.exposeInMainWorld("checkinApi", api);
