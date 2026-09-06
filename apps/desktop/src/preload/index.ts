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
  chooseAndImportSchedule: (input) => ipcRenderer.invoke(IPC_CHANNELS.importSchedule, input),
  saveImportTemplate: (kind) => ipcRenderer.invoke(IPC_CHANNELS.saveImportTemplate, kind),
  chooseAndImportMembers: () => ipcRenderer.invoke(IPC_CHANNELS.importMembers),
  listMembers: () => ipcRenderer.invoke(IPC_CHANNELS.members),
  saveMember: (member) => ipcRenderer.invoke(IPC_CHANNELS.saveMember, member),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settings),
  updateSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.updateSettings, settings),
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
