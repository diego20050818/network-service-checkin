import { contextBridge, ipcRenderer } from "electron";
import type { CheckinApi } from "../shared/contracts";
import { IPC_CHANNELS } from "../shared/ipc-channels";

const api: CheckinApi = {
  planOvertime: (input) => ipcRenderer.invoke(IPC_CHANNELS.planOvertime, input),
  listOccurrences: (filters) =>
    ipcRenderer.invoke(IPC_CHANNELS.occurrences, filters),
  saveOccurrence: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveOccurrence, input),
  cancelOccurrence: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelOccurrence, input),
  attendanceAction: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.attendanceAction, input),
  listOperations: () => ipcRenderer.invoke(IPC_CHANNELS.operations),
  undoOperation: (id) => ipcRenderer.invoke(IPC_CHANNELS.undoOperation, id),
  getDataRevision: () => ipcRenderer.invoke(IPC_CHANNELS.dataRevision),
  chooseImportPreview: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.importPreview, input),
  applyImportPreview: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.applyImportPreview, input),
  onCloseRequested: (listener) => {
    const handler = async (
      _event: Electron.IpcRendererEvent,
      requestId: string,
    ) => {
      let allowed = false;
      try {
        allowed = await listener();
      } finally {
        await ipcRenderer.invoke(
          IPC_CHANNELS.closeResponse,
          requestId,
          allowed,
        );
      }
    };
    ipcRenderer.on(IPC_CHANNELS.closeRequested, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.closeRequested, handler);
  },
  bootstrap: (now) => ipcRenderer.invoke(IPC_CHANNELS.bootstrap, now),
  getCurrentShifts: (now) =>
    ipcRenderer.invoke(IPC_CHANNELS.currentShifts, now),
  getShiftsForDate: (date) =>
    ipcRenderer.invoke(IPC_CHANNELS.shiftsForDate, date),
  checkIn: (shiftId, selections, now) =>
    ipcRenderer.invoke(IPC_CHANNELS.checkIn, shiftId, selections, now),
  listRecords: (filters) => ipcRenderer.invoke(IPC_CHANNELS.records, filters),
  correctRecord: (recordId, memberId) =>
    ipcRenderer.invoke(IPC_CHANNELS.correctRecord, recordId, memberId),
  revokeRecord: (recordId) =>
    ipcRenderer.invoke(IPC_CHANNELS.revokeRecord, recordId),
  restoreRecord: (recordId) =>
    ipcRenderer.invoke(IPC_CHANNELS.restoreRecord, recordId),
  addManualAttendance: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.manualRecord, input),
  getDashboard: (filters) =>
    ipcRenderer.invoke(IPC_CHANNELS.dashboard, filters),
  listLeaves: (filters) => ipcRenderer.invoke(IPC_CHANNELS.leaves, filters),
  createLeave: (input) => ipcRenderer.invoke(IPC_CHANNELS.createLeave, input),
  updateLeave: (leaveId, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateLeave, leaveId, input),
  cancelLeave: (leaveId) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelLeave, leaveId),
  addShiftStaff: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.addShiftStaff, input),
  removeShiftStaff: (slotId) =>
    ipcRenderer.invoke(IPC_CHANNELS.removeShiftStaff, slotId),
  listOvertime: (filters) => ipcRenderer.invoke(IPC_CHANNELS.overtime, filters),
  createOvertime: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.createOvertime, input),
  cancelOvertime: (slotId) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelOvertime, slotId),
  chooseAndImportSchedule: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.importSchedule, input),
  saveImportTemplate: (kind) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveImportTemplate, kind),
  chooseAndImportMembers: () => ipcRenderer.invoke(IPC_CHANNELS.importMembers),
  listMembers: () => ipcRenderer.invoke(IPC_CHANNELS.members),
  saveMember: (member) => ipcRenderer.invoke(IPC_CHANNELS.saveMember, member),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settings),
  updateSettings: (settings) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateSettings, settings),
  getShiftTimeSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.shiftTimeSettings),
  updateShiftTimeSettings: (settings) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateShiftTimeSettings, settings),
  getUpdateSettings: () => ipcRenderer.invoke(IPC_CHANNELS.updateMode),
  setUpdateMode: (mode) => ipcRenderer.invoke(IPC_CHANNELS.setUpdateMode, mode),
  getUpdateState: () => ipcRenderer.invoke(IPC_CHANNELS.updateState),
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.checkUpdate),
  downloadUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.installUpdate),
  onUpdateStateChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: Parameters<typeof listener>[0],
    ) => listener(state);
    ipcRenderer.on(IPC_CHANNELS.updateStateChanged, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.updateStateChanged, handler);
  },
  onAttendanceReminder: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: Parameters<typeof listener>[0],
    ) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.attendanceReminder, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.attendanceReminder, handler);
  },
  getStartupSettings: () => ipcRenderer.invoke(IPC_CHANNELS.startupSettings),
  setStartupEnabled: (enabled) =>
    ipcRenderer.invoke(IPC_CHANNELS.setStartupEnabled, enabled),
  getStorageOverview: () => ipcRenderer.invoke(IPC_CHANNELS.storageOverview),
  chooseAndSetStorageDirectory: (kind) =>
    ipcRenderer.invoke(IPC_CHANNELS.chooseStorageDirectory, kind),
  getReportDraft: (year, month) =>
    ipcRenderer.invoke(IPC_CHANNELS.reportDraft, year, month),
  saveReportDraft: (draft) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveReportDraft, draft),
  previewReports: (draft) =>
    ipcRenderer.invoke(IPC_CHANNELS.previewReports, draft),
  chooseOutputDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chooseOutput),
  exportReports: (draft, dataRevision, operationId) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.exportReports,
      draft,
      dataRevision,
      operationId,
    ),
  openPath: (path) => ipcRenderer.invoke(IPC_CHANNELS.openPath, path),
  openDataDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.openData),
  createBackup: () => ipcRenderer.invoke(IPC_CHANNELS.backup),
  listBackups: () => ipcRenderer.invoke(IPC_CHANNELS.backups),
  restoreBackup: (path) =>
    ipcRenderer.invoke(IPC_CHANNELS.restoreManagedBackup, path),
  chooseAndRestoreBackup: () => ipcRenderer.invoke(IPC_CHANNELS.restoreBackup),
};

contextBridge.exposeInMainWorld("checkinApi", api);
