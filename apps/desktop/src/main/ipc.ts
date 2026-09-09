import { app, dialog, ipcMain, shell } from "electron";
import { copyFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import type { CheckinApi, ReportDraft } from "../shared/contracts";
import type { DatabaseStore } from "./database";
import type { AttendanceService } from "./services/attendance-service";
import type { AdjustmentService } from "./services/adjustment-service";
import type { BackupService } from "./services/backup-service";
import type { DashboardService } from "./services/dashboard-service";
import type { MemberService } from "./services/member-service";
import type { ReportService } from "./services/report-service";
import type { ScheduleService } from "./services/schedule-service";
import type { SettingsService } from "./services/settings-service";
import type { StartupService } from "./services/startup-service";
import type { StorageService } from "./services/storage-service";
import type { UpdateService } from "./services/update-service";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { OccurrenceService } from "./services/occurrence-service";
import { ImportPreviewService } from "./services/import-preview-service";
import { writeScheduleImportTemplate } from "./services/schedule-template";

export interface ServiceContext {
  beforeInstall?: () => Promise<boolean>;
  store: DatabaseStore;
  attendance: AttendanceService;
  adjustments: AdjustmentService;
  dashboard: DashboardService;
  members: MemberService;
  schedule: ScheduleService;
  settings: SettingsService;
  startup: StartupService;
  storage: StorageService;
  reports: ReportService;
  backup: BackupService;
  updates: UpdateService;
  dataDirectory: string;
  templateDirectory: string;
}

const id = z.string().uuid();
const isoDate = z.iso.date();
const optionalIsoDateTime = z.string().datetime({ offset: true }).optional();
const kind = z.enum(["desk", "maintenance", "weekend", "overtime", "all"]);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const shiftTimeRange = z.object({ startTime: time, endTime: time });
const shiftTimeSettings = z.object({
  weekdayDesk1: shiftTimeRange,
  weekdayDesk2: shiftTimeRange,
  weekdayDesk3: shiftTimeRange,
  weekdayDesk4: shiftTimeRange,
  maintenance: shiftTimeRange,
  weekendMorning: shiftTimeRange,
  weekendAfternoon: shiftTimeRange,
});

const scoreSchema = z.object({
  attendance: z.number().min(0).max(30).nullable(),
  hours: z.number().min(0).max(10).nullable(),
  self: z.number().min(0).max(10).nullable(),
  peer: z.number().min(0).max(20).nullable(),
  supervisor: z.number().min(0).max(30).nullable(),
  activity: z.number().min(0).max(5).nullable(),
  attendanceOverridden: z.boolean().optional(),
});

const reportDraftSchema: z.ZodType<ReportDraft> = z.object({
  revision: z.number().int().min(0).optional(),
  year: z.number().int().min(2000).max(2200),
  month: z.number().int().min(1).max(12),
  fillDate: isoDate,
  startDate: isoDate,
  endDate: isoDate,
  filler: z.string().max(100),
  department: z.string().max(100),
  outputDirectory: z.string().max(1000),
  workItems: z.tuple([
    z.string().max(5000),
    z.string().max(5000),
    z.string().max(5000),
  ]),
  questions: z.tuple([
    z.string().max(5000),
    z.string().max(5000),
    z.string().max(5000),
  ]),
  reflections: z.tuple([
    z.string().max(5000),
    z.string().max(5000),
    z.string().max(5000),
  ]),
  plans: z.tuple([
    z.string().max(5000),
    z.string().max(5000),
    z.string().max(5000),
  ]),
  advice: z.string().max(5000),
  scores: z.record(z.string(), scoreSchema),
  recommendations: z.tuple([
    z.object({ memberId: id.nullable(), reason: z.string().max(5000) }),
    z.object({ memberId: id.nullable(), reason: z.string().max(5000) }),
  ]),
  wageWorkloads: z.record(z.string(), z.string().max(100)),
  wageNotes: z.record(z.string(), z.string().max(1000)),
  selectedFiles: z.array(
    z.enum([
      "workReport",
      "performance",
      "timeRecord",
      "schedule",
      "wageAssessment",
    ]),
  ),
});

function invoke<T extends keyof CheckinApi>(
  channel: string,
  handler: (...args: unknown[]) => ReturnType<CheckinApi[T]>,
): void {
  ipcMain.handle(channel, (_event, ...args) => handler(...args));
}

function inside(parent: string, child: string): boolean {
  const root = resolve(parent).toLocaleLowerCase();
  const target = resolve(child).toLocaleLowerCase();
  return target === root || target.startsWith(`${root}${sep}`);
}

export function registerIpcHandlers(context: ServiceContext): void {
  const occurrences = new OccurrenceService(
    context.store,
    context.attendance,
    context.adjustments,
    context.members,
  );
  const imports = new ImportPreviewService(
    context.store,
    context.schedule,
    context.members,
    context.settings,
  );
  const commandBase = {
    operationId: id,
    shiftId: id,
    expectedRevision: z.number().int().min(0).optional(),
  };
  const actionSchema = z.discriminatedUnion("type", [
    z.object({
      ...commandBase,
      type: z.literal("createLeave"),
      slotId: id,
      replacementMemberId: id.nullable().optional(),
      reason: z.string().max(500).optional(),
    }),
    z.object({
      ...commandBase,
      type: z.literal("updateLeave"),
      leaveId: id,
      replacementMemberId: id.nullable().optional(),
      reason: z.string().max(500).optional(),
    }),
    z.object({ ...commandBase, type: z.literal("cancelLeave"), leaveId: id }),
    z.object({ ...commandBase, type: z.literal("restoreLeave"), leaveId: id }),
    z.object({ ...commandBase, type: z.literal("cancelOvertime"), slotId: id }),
    z.object({
      ...commandBase,
      type: z.literal("restoreOvertime"),
      slotId: id,
    }),
    z.object({
      ...commandBase,
      type: z.literal("checkin"),
      selections: z.array(z.object({ slotId: id, memberId: id })).min(1),
    }),
    z.object({
      ...commandBase,
      type: z.literal("manual"),
      slotId: id,
      memberId: id,
      historicalPunchTime: z.string().datetime().nullable().optional(),
    }),
    z.object({ ...commandBase, type: z.literal("addStaff"), memberId: id }),
    z.object({ ...commandBase, type: z.literal("removeStaff"), slotId: id }),
    z.object({ ...commandBase, type: z.literal("restoreStaff"), slotId: id }),
    z.object({
      ...commandBase,
      type: z.literal("revokeAndRemove"),
      slotId: id,
      recordId: id,
    }),
    z.object({
      ...commandBase,
      type: z.literal("correct"),
      recordId: id,
      memberId: id,
    }),
    z.object({ ...commandBase, type: z.literal("revoke"), recordId: id }),
    z.object({ ...commandBase, type: z.literal("restore"), recordId: id }),
  ]);
  invoke(IPC_CHANNELS.occurrences, async (filters) =>
    occurrences.list(
      z
        .object({
          startDate: isoDate,
          endDate: isoDate,
          includeCancelled: z.boolean().optional(),
        })
        .parse(filters),
    ),
  );
  invoke(IPC_CHANNELS.saveOccurrence, async (input) =>
    occurrences.save(
      z
        .object({
          id: id.optional(),
          operationId: id,
          expectedRevision: z.number().int().min(0).optional(),
          date: isoDate,
          startTime: time,
          endTime: time,
          kind: z.enum(["desk", "maintenance", "weekend"]),
          workType: z.enum(["regular", "overtime"]),
          label: z.string().trim().min(1).max(100),
          note: z.string().max(500),
          memberIds: z.array(id).min(1).max(100),
          confirmImpact: z.boolean().optional(),
        })
        .parse(input),
    ),
  );
  invoke(IPC_CHANNELS.cancelOccurrence, async (input) =>
    occurrences.cancel(
      z
        .object({
          id,
          operationId: id,
          expectedRevision: z.number().int().min(0),
        })
        .parse(input),
    ),
  );
  invoke(IPC_CHANNELS.attendanceAction, async (input) =>
    occurrences.action(actionSchema.parse(input)),
  );
  invoke(IPC_CHANNELS.planOvertime, async (input) =>
    occurrences.planOvertime(
      z
        .object({
          operationId: id,
          memberId: id,
          date: isoDate,
          startTime: time,
          endTime: time,
          note: z.string().max(500).optional(),
        })
        .parse(input),
    ),
  );
  invoke(IPC_CHANNELS.operations, async () => occurrences.listOperations());
  invoke(IPC_CHANNELS.undoOperation, async (value) =>
    occurrences.undo(id.parse(value)),
  );
  invoke(IPC_CHANNELS.dataRevision, async () => context.store.dataRevision());
  invoke(IPC_CHANNELS.importPreview, async (input) => {
    const parsed = z
      .object({
        kind: z.enum(["schedule", "members"]),
        month: z.string().regex(/^\d{4}-\d{2}$/),
        effectiveDate: isoDate,
      })
      .parse(input);
    const selected = await dialog.showOpenDialog({
      title:
        parsed.kind === "schedule"
          ? "选择正式排班 Excel"
          : "选择成员信息 Excel",
      properties: ["openFile"],
      filters: [{ name: "Excel 工作簿", extensions: ["xlsx", "xlsm"] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return null;
    return imports.preview(selected.filePaths[0], parsed);
  });
  invoke(IPC_CHANNELS.applyImportPreview, async (input) =>
    imports.apply(
      z
        .object({
          id,
          resolutions: z.record(z.string(), z.enum(["keep", "replace"])),
        })
        .parse(input),
    ),
  );
  const chosenOutputDirectories = new Set<string>();
  const isPersistedOutputDirectory = (directory: string): boolean => {
    const rows = context.store
      .prepare("SELECT payload_json FROM report_drafts")
      .all() as unknown as Array<{ payload_json: string }>;
    return rows.some((row) => {
      try {
        return (
          resolve(
            (JSON.parse(row.payload_json) as ReportDraft).outputDirectory,
          ) === resolve(directory)
        );
      } catch {
        return false;
      }
    });
  };
  const validateOutputDirectory = (directory: string): void => {
    if (!directory) return;
    const normalized = resolve(directory);
    const isDefaultDirectory =
      resolve(context.settings.getStorage().defaultOutputDirectory) ===
      normalized;
    if (
      !chosenOutputDirectories.has(normalized) &&
      !isPersistedOutputDirectory(normalized) &&
      !isDefaultDirectory
    ) {
      throw new Error("输出目录必须通过系统目录选择器选择");
    }
  };
  const relaunchAfterRestore = (): void => {
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 250);
  };

  invoke(IPC_CHANNELS.bootstrap, async (now) => {
    const nowValue = z
      .string()
      .datetime({ offset: true })
      .optional()
      .parse(now);
    const shifts = context.attendance.getCurrentAndNext(nowValue);
    const date = nowValue ? new Date(nowValue) : new Date();
    const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return {
      members: context.members.list(),
      todayShifts: context.attendance.getShiftsForDate(localDate),
      currentShifts: shifts.current,
      nextShifts: shifts.next,
      todayRecords: context.attendance.listRecords({
        startDate: localDate,
        endDate: localDate,
      }),
      settings: context.settings.get(),
      updateSettings: context.updates.mode(),
      updateState: context.updates.state(),
      startup: context.startup.get(),
      dataDirectory: context.dataDirectory,
    };
  });

  invoke(IPC_CHANNELS.currentShifts, async (now) =>
    context.attendance.getCurrentAndNext(optionalIsoDateTime.parse(now)),
  );
  invoke(IPC_CHANNELS.shiftsForDate, async (date) =>
    context.attendance.getShiftsForDate(isoDate.parse(date)),
  );
  invoke(IPC_CHANNELS.checkIn, async (shiftId, selections, now) => {
    const parsed = z
      .object({
        shiftId: id,
        selections: z.array(z.object({ slotId: id, memberId: id })).min(1),
        now: optionalIsoDateTime,
      })
      .parse({ shiftId, selections, now });
    return context.attendance.checkIn(
      parsed.shiftId,
      parsed.selections,
      parsed.now,
    );
  });
  invoke(IPC_CHANNELS.records, async (filters) =>
    context.attendance.listRecords(
      z
        .object({
          startDate: isoDate.optional(),
          endDate: isoDate.optional(),
          memberId: id.optional(),
          shiftId: id.optional(),
          kind: kind.optional(),
          includeRevoked: z.boolean().optional(),
        })
        .parse(filters),
    ),
  );
  invoke(IPC_CHANNELS.correctRecord, async (recordId, memberId) =>
    context.attendance.correctMember(id.parse(recordId), id.parse(memberId)),
  );
  invoke(IPC_CHANNELS.revokeRecord, async (recordId) =>
    context.attendance.revoke(id.parse(recordId)),
  );
  invoke(IPC_CHANNELS.restoreRecord, async (recordId) =>
    context.attendance.restore(id.parse(recordId)),
  );
  invoke(IPC_CHANNELS.manualRecord, async (input) =>
    context.attendance.addManual(
      z
        .object({
          slotId: id,
          memberId: id,
          historicalPunchTime: z
            .string()
            .datetime({ offset: true })
            .nullable()
            .optional(),
        })
        .parse(input),
    ),
  );
  invoke(IPC_CHANNELS.dashboard, async (filters) =>
    context.dashboard.snapshot(
      z
        .object({
          startDate: isoDate,
          endDate: isoDate,
          kind: kind.optional(),
          memberId: id.optional(),
          now: optionalIsoDateTime,
        })
        .parse(filters),
    ),
  );

  const adjustmentFilters = z.object({
    startDate: isoDate,
    endDate: isoDate,
    includeCancelled: z.boolean().optional(),
  });
  const leaveInput = z.object({
    slotId: id,
    replacementMemberId: id.nullable().optional(),
    reason: z.string().max(500).optional(),
  });
  const leaveUpdate = z.object({
    replacementMemberId: id.nullable().optional(),
    reason: z.string().max(500).optional(),
  });
  invoke(IPC_CHANNELS.leaves, async (filters) =>
    context.adjustments.listLeaves(adjustmentFilters.parse(filters)),
  );
  invoke(IPC_CHANNELS.createLeave, async (input) =>
    context.adjustments.createLeave(leaveInput.parse(input)),
  );
  invoke(IPC_CHANNELS.updateLeave, async (leaveId, input) =>
    context.adjustments.updateLeave(
      id.parse(leaveId),
      leaveUpdate.parse(input),
    ),
  );
  invoke(IPC_CHANNELS.cancelLeave, async (leaveId) =>
    context.adjustments.cancelLeave(id.parse(leaveId)),
  );
  invoke(IPC_CHANNELS.addShiftStaff, async (input) =>
    context.adjustments.addShiftStaff(
      z.object({ shiftId: id, memberId: id }).parse(input),
    ),
  );
  invoke(IPC_CHANNELS.removeShiftStaff, async (slotId) =>
    context.adjustments.removeShiftStaff(id.parse(slotId)),
  );
  invoke(IPC_CHANNELS.overtime, async (filters) =>
    context.adjustments.listOvertime(adjustmentFilters.parse(filters)),
  );
  invoke(IPC_CHANNELS.createOvertime, async (input) =>
    context.adjustments.createOvertime(
      z
        .object({
          memberId: id,
          date: isoDate,
          startTime: time,
          endTime: time,
          note: z.string().max(500).optional(),
        })
        .parse(input),
    ),
  );
  invoke(IPC_CHANNELS.cancelOvertime, async (slotId) =>
    context.adjustments.cancelOvertime(id.parse(slotId)),
  );

  invoke(IPC_CHANNELS.importSchedule, async (input) => {
    const parsed = z
      .object({
        month: z.string().regex(/^\d{4}-\d{2}$/),
        effectiveDate: isoDate,
      })
      .parse(input);
    const result = await dialog.showOpenDialog({
      title: "选择正式排班 Excel",
      properties: ["openFile"],
      filters: [{ name: "Excel 工作簿", extensions: ["xlsx", "xlsm"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return context.schedule.import(
      result.filePaths[0],
      parsed.month,
      parsed.effectiveDate,
      context.settings.get(),
    );
  });
  invoke(IPC_CHANNELS.saveImportTemplate, async (templateKind) => {
    const parsedKind = z.enum(["schedule", "members"]).parse(templateKind);
    const fileName =
      parsedKind === "schedule"
        ? "网络服务小组排班导入模板.xlsx"
        : "网络中心员工信息表格.xlsx";
    const result = await dialog.showSaveDialog({
      title:
        parsedKind === "schedule" ? "保存排班导入模板" : "保存人员信息模板",
      defaultPath: join(app.getPath("downloads"), fileName),
      filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
    });
    if (result.canceled || !result.filePath) return null;
    if (parsedKind === "schedule")
      await writeScheduleImportTemplate(
        result.filePath,
        context.settings.getShiftTimeSettings(),
      );
    else {
      const sourcePath = join(context.templateDirectory, fileName);
      if (resolve(sourcePath) !== resolve(result.filePath))
        await copyFile(sourcePath, result.filePath);
    }
    return result.filePath;
  });
  invoke(IPC_CHANNELS.importMembers, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择成员信息 Excel",
      properties: ["openFile"],
      filters: [{ name: "Excel 工作簿", extensions: ["xlsx", "xlsm"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return context.members.importWorkbook(result.filePaths[0]);
  });
  invoke(IPC_CHANNELS.members, async () => context.members.list());
  invoke(IPC_CHANNELS.saveMember, async (member) =>
    context.members.save(
      z
        .object({
          id: id.optional(),
          name: z.string().trim().min(1).max(100),
          college: z.string().max(100).optional(),
          role: z.string().max(100).optional(),
          phone: z.string().max(100).optional(),
          studentId: z.string().max(100).optional(),
          major: z.string().max(100).optional(),
          grade: z.string().max(100).optional(),
          employeeNo: z.string().max(100).optional(),
          active: z.boolean().optional(),
        })
        .parse(member),
    ),
  );
  invoke(IPC_CHANNELS.settings, async () => context.settings.get());
  invoke(IPC_CHANNELS.updateSettings, async (settings) =>
    context.settings.update(
      z
        .object({
          attendanceMode: z.enum(["lenient", "late_mark"]),
          lateThresholdMinutes: z.number().int().min(0).max(180),
          latePenaltyPoints: z.number().min(0).max(30),
        })
        .parse(settings),
    ),
  );
  invoke(IPC_CHANNELS.shiftTimeSettings, async () =>
    context.settings.getShiftTimeSettings(),
  );
  invoke(IPC_CHANNELS.updateShiftTimeSettings, async (settings) =>
    context.settings.updateShiftTimeSettings(shiftTimeSettings.parse(settings)),
  );
  invoke(IPC_CHANNELS.updateMode, async () => context.updates.mode());
  invoke(IPC_CHANNELS.setUpdateMode, async (mode) =>
    context.updates.setMode(z.enum(["manual", "automatic"]).parse(mode)),
  );
  invoke(IPC_CHANNELS.updateState, async () => context.updates.state());
  invoke(IPC_CHANNELS.checkUpdate, async () => context.updates.check());
  invoke(IPC_CHANNELS.downloadUpdate, async () => context.updates.download());
  invoke(IPC_CHANNELS.installUpdate, async () => {
    if (!context.beforeInstall || (await context.beforeInstall()))
      context.updates.install();
  });
  invoke(IPC_CHANNELS.startupSettings, async () => context.startup.get());
  invoke(IPC_CHANNELS.setStartupEnabled, async (enabled) =>
    context.startup.setEnabled(z.boolean().parse(enabled)),
  );
  invoke(IPC_CHANNELS.storageOverview, async () => context.storage.overview());
  invoke(IPC_CHANNELS.chooseStorageDirectory, async (storageKind) => {
    const parsedKind = z.enum(["output", "backup"]).parse(storageKind);
    const current = context.settings.getStorage();
    const result = await dialog.showOpenDialog({
      title: parsedKind === "output" ? "选择默认月报输出目录" : "选择备份目录",
      defaultPath:
        parsedKind === "output"
          ? current.defaultOutputDirectory
          : current.backupDirectory,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return context.storage.setDirectory(parsedKind, result.filePaths[0]);
  });

  invoke(IPC_CHANNELS.reportDraft, async (year, month) =>
    context.reports.getDraft(
      z.number().int().parse(year),
      z.number().int().parse(month),
    ),
  );
  invoke(IPC_CHANNELS.saveReportDraft, async (draft) => {
    const parsed = reportDraftSchema.parse(draft);
    validateOutputDirectory(parsed.outputDirectory);
    return context.reports.saveDraft(parsed);
  });
  invoke(IPC_CHANNELS.previewReports, async (draft) =>
    context.reports.preview(reportDraftSchema.parse(draft)),
  );
  invoke(IPC_CHANNELS.chooseOutput, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择月报输出目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const directory = resolve(result.filePaths[0]);
    chosenOutputDirectories.add(directory);
    return directory;
  });
  invoke(
    IPC_CHANNELS.exportReports,
    async (draft, dataRevision, operationId) => {
      const parsed = reportDraftSchema.parse(draft);
      validateOutputDirectory(parsed.outputDirectory);
      return context.reports.export(
        parsed,
        z.number().int().min(0).optional().parse(dataRevision),
        id.optional().parse(operationId),
      );
    },
  );

  invoke(IPC_CHANNELS.openPath, async (path) => {
    const value = z.string().min(1).max(2000).parse(path);
    const exportRows = context.store
      .prepare("SELECT output_directory FROM export_batches")
      .all() as unknown as Array<{ output_directory: string }>;
    const allowed =
      context.storage.managedRoots().some((root) => inside(root, value)) ||
      exportRows.some((row) => inside(row.output_directory, value));
    if (!allowed) throw new Error("拒绝打开未授权路径");
    return shell.openPath(value);
  });
  invoke(IPC_CHANNELS.openData, async () =>
    shell.openPath(context.dataDirectory),
  );
  invoke(IPC_CHANNELS.backup, async () => context.backup.create("manual"));
  invoke(IPC_CHANNELS.backups, async () => context.backup.list());
  invoke(IPC_CHANNELS.restoreManagedBackup, async (path) => {
    if (context.beforeInstall && !(await context.beforeInstall())) return false;
    await context.backup.restoreManaged(
      z.string().min(1).max(2000).parse(path),
    );
    relaunchAfterRestore();
    return true;
  });
  invoke(IPC_CHANNELS.restoreBackup, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择备份目录",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return false;
    if (context.beforeInstall && !(await context.beforeInstall())) return false;
    await context.backup.restore(result.filePaths[0]);
    relaunchAfterRestore();
    return true;
  });
}

export function removeIpcHandlers(): void {
  for (const channel of Object.values(IPC_CHANNELS))
    ipcMain.removeHandler(channel);
}
