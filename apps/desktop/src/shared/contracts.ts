export type ShiftKind = "desk" | "maintenance" | "weekend";
export type AttendanceMode = "lenient" | "late_mark";
export type LateStatus = "normal" | "late" | "manual_unjudged";
export type AttendanceSource = "realtime" | "manual";

export interface Member {
  id: string;
  name: string;
  college: string;
  role: string;
  phone: string;
  studentId: string;
  major: string;
  grade: string;
  employeeNo: string;
  active: boolean;
}

export interface ShiftSlotView {
  id: string;
  position: number;
  scheduledMemberId: string | null;
  scheduledMemberName: string | null;
  attendanceId: string | null;
  actualMemberId: string | null;
  actualMemberName: string | null;
  punchTime: string | null;
  lateStatus: LateStatus | null;
}

export interface ShiftView {
  id: string;
  date: string;
  kind: ShiftKind;
  label: string;
  startTime: string;
  endTime: string;
  paidMinutes: number;
  attendanceMode: AttendanceMode;
  lateThresholdMinutes: number;
  slots: ShiftSlotView[];
}

export interface AttendanceRecordView {
  id: string;
  shiftId: string;
  slotId: string;
  date: string;
  kind: ShiftKind;
  label: string;
  startTime: string;
  endTime: string;
  scheduledMemberName: string | null;
  actualMemberId: string;
  actualMemberName: string;
  punchTime: string | null;
  enteredAt: string;
  paidMinutes: number;
  lateStatus: LateStatus;
  source: AttendanceSource;
  status: "active" | "revoked";
}

export interface CheckInSelection {
  slotId: string;
  memberId: string;
}

export interface CheckInResult {
  record: AttendanceRecordView;
  alreadyExisted: boolean;
}

export interface DashboardFilters {
  startDate: string;
  endDate: string;
  kind?: ShiftKind | "all";
  memberId?: string;
  now?: string;
}

export interface DashboardMetrics {
  paidMinutes: number;
  attendanceRate: number | null;
  attendedEndedSlots: number;
  endedSlots: number;
  lateCount: number;
  missingEndedSlots: number;
  manualUnjudgedCount: number;
}

export interface MemberSummary {
  memberId: string;
  memberName: string;
  shiftCount: number;
  deskMinutes: number;
  maintenanceMinutes: number;
  weekendMinutes: number;
  totalMinutes: number;
  lateCount: number;
  substituteCount: number;
}

export interface DashboardSnapshot {
  filters: DashboardFilters;
  metrics: DashboardMetrics;
  members: MemberSummary[];
  records: AttendanceRecordView[];
}

export interface ScoreEntry {
  attendance: number | null;
  hours: number | null;
  self: number | null;
  peer: number | null;
  supervisor: number | null;
  activity: number | null;
  attendanceOverridden?: boolean;
}

export interface Recommendation {
  memberId: string | null;
  reason: string;
}

export type ReportFileKey =
  | "workReport"
  | "performance"
  | "timeRecord"
  | "schedule"
  | "wageAssessment";

export interface ReportDraft {
  year: number;
  month: number;
  fillDate: string;
  startDate: string;
  endDate: string;
  filler: string;
  department: string;
  outputDirectory: string;
  workItems: [string, string, string];
  questions: [string, string, string];
  reflections: [string, string, string];
  plans: [string, string, string];
  advice: string;
  scores: Record<string, ScoreEntry>;
  recommendations: [Recommendation, Recommendation];
  wageWorkloads: Record<string, string>;
  wageNotes: Record<string, string>;
  selectedFiles: ReportFileKey[];
}

export interface PreviewTable {
  title: string;
  headers: string[];
  rows: Array<Array<string | number>>;
}

export interface ReportFilePreview {
  key: ReportFileKey;
  fileName: string;
  type: "docx" | "xlsx";
  title: string;
  paragraphs: string[];
  tables: PreviewTable[];
  warnings: string[];
}

export interface ReportPreview {
  files: ReportFilePreview[];
  snapshot: DashboardSnapshot;
  warnings: string[];
}

export interface ExportedFile {
  key: ReportFileKey;
  fileName: string;
  path: string;
  templateSha256: string | null;
}

export interface ExportResult {
  batchId: string;
  directory: string;
  files: ExportedFile[];
  warnings: string[];
}

export interface ScheduleImportResult {
  importId: string;
  fileName: string;
  month: string;
  effectiveDate: string;
  shiftCount: number;
  slotCount: number;
  createdMembers: string[];
  warnings: string[];
  duplicate: boolean;
}

export interface Settings {
  attendanceMode: AttendanceMode;
  lateThresholdMinutes: number;
  latePenaltyPoints: number;
}

export interface StartupSettings {
  supported: boolean;
  enabled: boolean;
}

export interface StorageSettings {
  defaultOutputDirectory: string;
  backupDirectory: string;
}

export interface SourceFileInfo {
  name: string;
  path: string;
  importedAt: string;
  exists: boolean;
  detail: string;
}

export interface StorageOverview {
  dataDirectory: string;
  databasePath: string;
  templateDirectory: string;
  scheduleSourceDirectory: string;
  memberSourceDirectory: string;
  settings: StorageSettings;
  activeScheduleFiles: SourceFileInfo[];
  latestMemberFile: SourceFileInfo | null;
  templateFiles: SourceFileInfo[];
}

export interface BackupEntry {
  name: string;
  path: string;
  createdAt: string;
  kind: "daily" | "manual" | "pre_restore";
  sizeBytes: number;
  valid: boolean;
}

export interface BootstrapData {
  members: Member[];
  todayShifts: ShiftView[];
  currentShifts: ShiftView[];
  nextShifts: ShiftView[];
  todayRecords: AttendanceRecordView[];
  settings: Settings;
  startup: StartupSettings;
  dataDirectory: string;
}

export interface ManualAttendanceInput {
  slotId: string;
  memberId: string;
  historicalPunchTime?: string | null;
}

export interface RecordFilters {
  startDate?: string;
  endDate?: string;
  memberId?: string;
  kind?: ShiftKind | "all";
  includeRevoked?: boolean;
}

export interface CheckinApi {
  bootstrap(now?: string): Promise<BootstrapData>;
  getCurrentShifts(now?: string): Promise<{ current: ShiftView[]; next: ShiftView[] }>;
  getShiftsForDate(date: string): Promise<ShiftView[]>;
  checkIn(shiftId: string, selections: CheckInSelection[], now?: string): Promise<CheckInResult[]>;
  listRecords(filters: RecordFilters): Promise<AttendanceRecordView[]>;
  correctRecord(recordId: string, memberId: string): Promise<AttendanceRecordView>;
  revokeRecord(recordId: string): Promise<void>;
  restoreRecord(recordId: string): Promise<AttendanceRecordView>;
  addManualAttendance(input: ManualAttendanceInput): Promise<AttendanceRecordView>;
  getDashboard(filters: DashboardFilters): Promise<DashboardSnapshot>;
  chooseAndImportSchedule(input: { month: string; effectiveDate: string }): Promise<ScheduleImportResult | null>;
  saveImportTemplate(kind: "schedule" | "members"): Promise<string | null>;
  chooseAndImportMembers(): Promise<{ imported: number; created: number; updated: number; fileName: string } | null>;
  listMembers(): Promise<Member[]>;
  saveMember(member: Partial<Member> & { name: string }): Promise<Member>;
  getSettings(): Promise<Settings>;
  updateSettings(settings: Settings): Promise<Settings>;
  getStartupSettings(): Promise<StartupSettings>;
  setStartupEnabled(enabled: boolean): Promise<StartupSettings>;
  getStorageOverview(): Promise<StorageOverview>;
  chooseAndSetStorageDirectory(kind: "output" | "backup"): Promise<StorageOverview | null>;
  getReportDraft(year: number, month: number): Promise<ReportDraft>;
  saveReportDraft(draft: ReportDraft): Promise<ReportDraft>;
  previewReports(draft: ReportDraft): Promise<ReportPreview>;
  chooseOutputDirectory(): Promise<string | null>;
  exportReports(draft: ReportDraft): Promise<ExportResult>;
  openPath(path: string): Promise<string>;
  openDataDirectory(): Promise<string>;
  createBackup(): Promise<string>;
  listBackups(): Promise<BackupEntry[]>;
  restoreBackup(path: string): Promise<boolean>;
  chooseAndRestoreBackup(): Promise<boolean>;
}
