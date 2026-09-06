import type { ReportDraft, ReportFileKey, ScoreEntry } from "../shared/contracts";
import { payrollPeriod } from "./time";

export const REPORT_FILE_KEYS: ReportFileKey[] = [
  "workReport",
  "performance",
  "timeRecord",
  "schedule",
  "wageAssessment",
];

export function defaultReportDraft(year: number, month: number): ReportDraft {
  const period = payrollPeriod(year, month);
  return {
    year,
    month,
    fillDate: `${year}-${String(month).padStart(2, "0")}-25`,
    ...period,
    filler: "",
    department: "网络中心服务小组",
    outputDirectory: "",
    workItems: ["", "", ""],
    questions: ["", "", ""],
    reflections: ["", "", ""],
    plans: ["", "", ""],
    advice: "",
    scores: {},
    recommendations: [
      { memberId: null, reason: "" },
      { memberId: null, reason: "" },
    ],
    wageWorkloads: {},
    wageNotes: {},
    selectedFiles: [...REPORT_FILE_KEYS],
  };
}

export function scoreTotal(score: ScoreEntry): number | null {
  const values = [score.attendance, score.hours, score.self, score.peer, score.supervisor, score.activity];
  if (values.some((value) => value === null)) return null;
  return Math.min(100, values.reduce<number>((sum, value) => sum + (value ?? 0), 0));
}

export function suggestedAttendanceScore(lateCount: number, penalty: number): number {
  return Math.max(0, 30 - lateCount * penalty);
}

export function sanitizeFilePart(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return sanitized.replace(/[. ]+$/g, "") || "未命名";
}

export function reportFileNames(draft: ReportDraft): Record<ReportFileKey, string> {
  const month = draft.month;
  const filler = sanitizeFilePart(draft.filler || "未填写");
  const compactDate = draft.fillDate.replace(/-/g, "");
  return {
    workReport: `${month}月工作报表-网络中心-${filler}.docx`,
    performance: `${month}月绩效考核表网络中心${filler}${compactDate}.docx`,
    timeRecord: `网络中心${month}月工时记录表.xlsx`,
    schedule: `网络中心${month}月排班表.docx`,
    wageAssessment: `网络中心月工资考核表 --${month}月 .docx`,
  };
}

export function validateScore(score: ScoreEntry): void {
  const ranges: Array<[keyof ScoreEntry, number]> = [
    ["attendance", 30],
    ["hours", 10],
    ["self", 10],
    ["peer", 20],
    ["supervisor", 30],
    ["activity", 5],
  ];
  for (const [key, max] of ranges) {
    const value = score[key];
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0 || value > max)) {
      throw new Error(`${String(key)} 评分必须在 0 到 ${max} 之间`);
    }
  }
}
