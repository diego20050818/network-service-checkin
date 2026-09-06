import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import PizZip from "pizzip";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  PageOrientation,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type {
  DashboardSnapshot,
  ExportResult,
  ExportedFile,
  Member,
  PreviewTable,
  ReportDraft,
  ReportFileKey,
  ReportFilePreview,
  ReportPreview,
  ScoreEntry,
} from "../../shared/contracts";
import {
  defaultReportDraft,
  reportFileNames,
  scoreTotal,
  suggestedAttendanceScore,
  validateScore,
} from "../../domain/report";
import { hoursLabel } from "../../domain/time";
import type { DatabaseStore } from "../database";
import type { DashboardService } from "./dashboard-service";
import type { MemberService } from "./member-service";
import type { SettingsService } from "./settings-service";

const TEMPLATE_NAMES: Partial<Record<ReportFileKey, string>> = {
  workReport: "[mouth]月工作报表-网络中心-[name].docx",
  performance: "[mouth]月绩效考核表网络中心[name][yyyymmdd].docx",
  timeRecord: "网络中心[mouth]月工时记录表.xlsx",
  schedule: "网络中心[mouth]月排班表.docx",
  wageAssessment: "网络中心月工资考核表 --[mouth]月 .docx",
};

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type ScheduleLine = {
  shiftId: string;
  date: string;
  kind: "desk" | "maintenance" | "weekend";
  label: string;
  startTime: string;
  endTime: string;
  people: string[];
};

function xmlDecode(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function xmlEncode(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function replaceTextNodes(fragment: string, transform: (value: string) => string): string {
  const expression = /(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g;
  const matches = [...fragment.matchAll(expression)];
  if (matches.length === 0) return fragment;
  const original = matches.map((match) => xmlDecode(match[2] ?? "")).join("");
  const replacement = transform(original);
  if (replacement === original) return fragment;
  const lengths = matches.map((match) => xmlDecode(match[2] ?? "").length);
  let cursor = 0;
  let matchIndex = 0;
  return fragment.replace(expression, (_whole, open: string, _text: string, close: string) => {
    const length = matchIndex === matches.length - 1 ? replacement.length - cursor : Math.min(lengths[matchIndex] ?? 0, replacement.length - cursor);
    const part = replacement.slice(cursor, cursor + Math.max(0, length));
    cursor += Math.max(0, length);
    matchIndex += 1;
    return `${open}${xmlEncode(part)}${close}`;
  });
}

function replaceTokens(xml: string, replacements: Record<string, string>): string {
  const ordered = Object.entries(replacements).sort((a, b) => b[0].length - a[0].length);
  return xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph) =>
    replaceTextNodes(paragraph, (text) => {
      let result = text;
      for (const [token, value] of ordered) result = result.split(token).join(value);
      return result;
    }),
  );
}

function visibleText(fragment: string): string {
  return [...fragment.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => xmlDecode(match[1] ?? "")).join("");
}

function setCellText(rowXml: string, cellIndex: number, value: string): string {
  const cells = [...rowXml.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)];
  const cell = cells[cellIndex];
  if (!cell || cell.index === undefined) return rowXml;
  const updated = replaceTextNodes(cell[0], () => value);
  return rowXml.slice(0, cell.index) + updated + rowXml.slice(cell.index + cell[0].length);
}

function replaceRepeatedRows(
  xml: string,
  marker: string,
  values: string[][],
): string {
  const rows = [...xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].filter((row) => visibleText(row[0]).includes(marker));
  if (rows.length === 0) throw new Error(`模板中未找到动态行标记 ${marker}`);
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last || first.index === undefined || last.index === undefined) throw new Error("模板动态行定位失败");
  const generated = values.map((cells, index) => {
    let row = rows[Math.min(index, rows.length - 1)]?.[0] ?? first[0];
    cells.forEach((value, cellIndex) => {
      row = setCellText(row, cellIndex, value);
    });
    return row;
  });
  return xml.slice(0, first.index) + generated.join("") + xml.slice(last.index + last[0].length);
}

function chineseDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

function scoreFor(memberId: string, draft: ReportDraft, summary: DashboardSnapshot["members"][number], penalty: number): ScoreEntry {
  const existing = draft.scores[memberId];
  if (existing) {
    validateScore(existing);
    return existing;
  }
  return {
    attendance: suggestedAttendanceScore(summary.lateCount, penalty),
    hours: 10,
    self: 10,
    peer: 20,
    supervisor: 30,
    activity: 0,
  };
}

function valueOrBlank(value: number | null): string {
  return value === null ? "" : String(value);
}

function workloadFor(memberId: string, draft: ReportDraft, snapshot: DashboardSnapshot): string {
  const custom = draft.wageWorkloads[memberId];
  if (custom !== undefined) return custom;
  const summary = snapshot.members.find((item) => item.memberId === memberId);
  return `${hoursLabel(summary?.totalMinutes ?? 0)}h`;
}

function excelCellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toLocaleDateString("zh-CN");
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return String(value.text);
    if ("result" in value) return value.result === undefined ? "" : String(value.result);
  }
  return String(value);
}

function worksheetRows(worksheet: ExcelJS.Worksheet): string[][] {
  let lastRow = 0;
  let lastColumn = 0;
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    lastRow = Math.max(lastRow, rowNumber);
    row.eachCell({ includeEmpty: false }, (_cell, columnNumber) => { lastColumn = Math.max(lastColumn, columnNumber); });
  });
  if (lastRow === 0 || lastColumn === 0) return [];
  const rows: string[][] = [];
  for (let rowNumber = 1; rowNumber <= Math.min(lastRow, 300); rowNumber += 1) {
    const values = Array.from({ length: Math.min(lastColumn, 30) }, (_, index) => excelCellText(worksheet.getCell(rowNumber, index + 1).value));
    if (values.some((value) => value.trim())) rows.push(values);
  }
  return rows;
}

function tableCell(text: string, bold = false): TableCell {
  return new TableCell({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text, bold, font: "Microsoft YaHei", size: 20 })],
      }),
    ],
  });
}

function wordTable(headers: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headers.map((header) => tableCell(header, true)), tableHeader: true }),
      ...rows.map((row) => new TableRow({ children: row.map((cell) => tableCell(cell)) })),
    ],
  });
}

export class ReportService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly dashboard: DashboardService,
    private readonly members: MemberService,
    private readonly settings: SettingsService,
    private readonly templateDirectory: string,
  ) {}

  getDraft(year: number, month: number): ReportDraft {
    const defaults = {
      ...defaultReportDraft(year, month),
      outputDirectory: this.settings.getStorage().defaultOutputDirectory,
    };
    const row = this.store.prepare("SELECT payload_json FROM report_drafts WHERE year = ? AND month = ?").get(year, month) as
      | { payload_json: string }
      | undefined;
    if (!row) return defaults;
    try {
      const draft = { ...defaults, ...(JSON.parse(row.payload_json) as ReportDraft) };
      return { ...draft, outputDirectory: draft.outputDirectory || defaults.outputDirectory };
    } catch {
      return defaults;
    }
  }

  saveDraft(draft: ReportDraft): ReportDraft {
    this.validateDraft(draft);
    const now = new Date().toISOString();
    this.store
      .prepare(`
        INSERT INTO report_drafts(id, year, month, payload_json, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(year, month) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
      `)
      .run(randomUUID(), draft.year, draft.month, JSON.stringify(draft), now);
    return this.getDraft(draft.year, draft.month);
  }

  preview(draft: ReportDraft): ReportPreview {
    this.validateDraft(draft);
    const snapshot = this.dashboard.snapshot({ startDate: draft.startDate, endDate: draft.endDate, kind: "all" });
    const members = this.members.list();
    const names = reportFileNames(draft);
    const schedule = this.scheduleLines(draft.startDate, draft.endDate);
    const warnings = this.buildWarnings(snapshot, members, schedule, draft);
    const files: ReportFilePreview[] = [
      {
        key: "workReport",
        fileName: names.workReport,
        type: "docx",
        title: `${draft.month}月工作报表`,
        paragraphs: [`部门：${draft.department}`, `填表人：${draft.filler || "未填写"}`, `日期：${chineseDate(draft.fillDate)}`],
        tables: [
          {
            title: "部门工作情况",
            headers: ["字段", "内容"],
            rows: [
              ...draft.workItems.map((value, index) => [`完成的工作 ${index + 1}`, value]),
              ...draft.questions.map((value, index) => [`问题 ${index + 1}`, `${value}\n${draft.reflections[index]}`]),
              ...draft.plans.map((value, index) => [`下月计划 ${index + 1}`, value]),
              ["意见建议", draft.advice],
            ],
          },
        ],
        warnings: [],
      },
      {
        key: "performance",
        fileName: names.performance,
        type: "docx",
        title: `${draft.month}月份绩效考核表`,
        paragraphs: [`统计人：${draft.filler || "未填写"}`, `时间：${chineseDate(draft.fillDate)}`],
        tables: [this.performancePreview(draft, snapshot)],
        warnings: [],
      },
      {
        key: "timeRecord",
        fileName: names.timeRecord,
        type: "xlsx",
        title: `${draft.month}月工时记录表`,
        paragraphs: [],
        tables: [
          {
            title: "计薪记录",
            headers: ["姓名", "日期", "班次", "开始", "结束", "计薪工时（h）"],
            rows: snapshot.records.map((record) => [
              record.actualMemberName,
              record.date,
              record.label,
              record.startTime,
              record.endTime,
              `${hoursLabel(record.paidMinutes)}h`,
            ]),
          },
        ],
        warnings: snapshot.metrics.manualUnjudgedCount ? [`有 ${snapshot.metrics.manualUnjudgedCount} 条人工补记未判定迟到`] : [],
      },
      {
        key: "schedule",
        fileName: names.schedule,
        type: "docx",
        title: `${draft.month}月排班表`,
        paragraphs: [],
        tables: [this.schedulePreview(schedule)],
        warnings: schedule.length === 0 ? ["统计范围内没有正式排班"] : [],
      },
      {
        key: "wageAssessment",
        fileName: names.wageAssessment,
        type: "docx",
        title: `${draft.year}年${draft.month}月工资考核表`,
        paragraphs: [`考核时间：${chineseDate(draft.startDate)} 至 ${chineseDate(draft.endDate)}`, `统计者：${draft.filler || "未填写"}`],
        tables: [
          {
            title: "工资考核",
            headers: ["序号", "工号", "姓名", "工作量", "所属学院", "职务", "短号", "备注"],
            rows: members.map((member, index) => {
              return [
                index + 1,
                member.employeeNo,
                member.name,
                workloadFor(member.id, draft, snapshot),
                member.college,
                member.role,
                member.phone,
                draft.wageNotes[member.id] ?? "",
              ];
            }),
          },
        ],
        warnings: [],
      },
    ];
    return { files, snapshot, warnings };
  }

  async export(draft: ReportDraft): Promise<ExportResult> {
    if (!draft.outputDirectory) throw new Error("请先选择输出目录");
    await access(draft.outputDirectory);
    const preview = this.preview(draft);
    const batchId = randomUUID();
    const batchDirectory = await this.createBatchDirectory(draft);
    const selected = new Set(draft.selectedFiles);
    const files: ExportedFile[] = [];
    const warnings = [...preview.warnings];
    const templates = await this.templateManifest();

    for (const file of preview.files.filter((item) => selected.has(item.key))) {
      const outputPath = join(batchDirectory, file.fileName);
      try {
        if (file.key === "workReport") await this.buildWorkReport(draft, outputPath);
        else if (file.key === "performance") await this.buildPerformanceReport(draft, preview.snapshot, outputPath);
        else if (file.key === "timeRecord") await this.buildTimeRecord(preview.snapshot, outputPath);
        else if (file.key === "schedule") await this.buildScheduleReport(draft, outputPath);
        else await this.buildWageReport(draft, preview.snapshot, outputPath);
        await this.validateGeneratedFile(outputPath, file.type);
        files.push({
          key: file.key,
          fileName: file.fileName,
          path: outputPath,
          templateSha256: templates[file.key]?.sha256 ?? null,
        });
      } catch (error) {
        warnings.push(`${file.fileName} 生成失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (files.length === 0) throw new Error(warnings.join("；") || "没有生成任何文件");

    const createdAt = new Date().toISOString();
    this.store.transaction(() => {
      this.store
        .prepare(`
          INSERT INTO export_batches(
            id, year, month, start_date, end_date, filler, fill_date, output_directory,
            snapshot_json, template_manifest_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          batchId,
          draft.year,
          draft.month,
          draft.startDate,
          draft.endDate,
          draft.filler,
          draft.fillDate,
          batchDirectory,
          JSON.stringify({ draft, dashboard: preview.snapshot, warnings }),
          JSON.stringify(templates),
          createdAt,
        );
      for (const file of files) {
        this.store
          .prepare(`
            INSERT INTO export_files(id, batch_id, file_key, file_name, file_path, template_sha256, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .run(randomUUID(), batchId, file.key, file.fileName, file.path, file.templateSha256, createdAt);
      }
    });
    return { batchId, directory: batchDirectory, files, warnings };
  }

  private validateDraft(draft: ReportDraft): void {
    if (!Number.isInteger(draft.year) || draft.year < 2000 || draft.year > 2200) throw new Error("所属年份无效");
    if (!Number.isInteger(draft.month) || draft.month < 1 || draft.month > 12) throw new Error("所属月份无效");
    if (draft.startDate > draft.endDate) throw new Error("统计开始日期不能晚于结束日期");
    for (const score of Object.values(draft.scores)) validateScore(score);
    for (const workload of Object.values(draft.wageWorkloads)) {
      if (workload.length > 100) throw new Error("工资考核表工作量不能超过 100 个字符");
    }
  }

  private performancePreview(draft: ReportDraft, snapshot: DashboardSnapshot): PreviewTable {
    const penalty = this.settings.get().latePenaltyPoints;
    return {
      title: "全员绩效",
      headers: ["成员", "考勤", "工时", "自评", "互评", "负责人", "活动", "总分"],
      rows: snapshot.members.map((summary) => {
        const score = scoreFor(summary.memberId, draft, summary, penalty);
        return [
          summary.memberName,
          valueOrBlank(score.attendance),
          valueOrBlank(score.hours),
          valueOrBlank(score.self),
          valueOrBlank(score.peer),
          valueOrBlank(score.supervisor),
          valueOrBlank(score.activity),
          valueOrBlank(scoreTotal(score)),
        ];
      }),
    };
  }

  private schedulePreview(schedule: ScheduleLine[]): PreviewTable {
    return {
      title: "正式排班",
      headers: ["日期", "类型", "时间", "原排班人员"],
      rows: schedule.map((line) => [line.date, line.label, `${line.startTime}-${line.endTime}`, line.people.join("、")]),
    };
  }

  private buildWarnings(snapshot: DashboardSnapshot, members: Member[], schedule: ScheduleLine[], draft: ReportDraft): string[] {
    const warnings: string[] = [];
    if (!draft.filler.trim()) warnings.push("尚未填写统计者姓名");
    if (snapshot.metrics.manualUnjudgedCount) warnings.push(`有 ${snapshot.metrics.manualUnjudgedCount} 条人工补记未判定迟到`);
    if (schedule.length === 0) warnings.push("统计范围内没有有效正式排班");
    const incomplete = members.filter((member) => !member.college || !member.role || !member.phone);
    if (incomplete.length) warnings.push(`${incomplete.length} 名成员的学院、职务或短号资料不完整，可留空导出`);
    return warnings;
  }

  private scheduleLines(startDate: string, endDate: string): ScheduleLine[] {
    const rows = this.store
      .prepare(`
        SELECT s.id AS shift_id, s.date, s.kind, s.label, s.start_time, s.end_time,
               ss.position, COALESCE(m.name, '空位') AS person
        FROM shifts s
        JOIN shift_slots ss ON ss.shift_id = s.id
        LEFT JOIN members m ON m.id = ss.scheduled_member_id
        WHERE s.active = 1 AND s.date BETWEEN ? AND ? AND ss.is_vacant = 0
        ORDER BY s.date, s.start_time, s.kind, ss.position
      `)
      .all(startDate, endDate) as unknown as Array<{
      shift_id: string;
      date: string;
      kind: ScheduleLine["kind"];
      label: string;
      start_time: string;
      end_time: string;
      position: number;
      person: string;
    }>;
    const result = new Map<string, ScheduleLine>();
    for (const row of rows) {
      const existing = result.get(row.shift_id);
      if (existing) existing.people.push(row.person);
      else {
        result.set(row.shift_id, {
          shiftId: row.shift_id,
          date: row.date,
          kind: row.kind,
          label: row.label,
          startTime: row.start_time,
          endTime: row.end_time,
          people: [row.person],
        });
      }
    }
    return [...result.values()];
  }

  private async templateManifest(): Promise<Record<string, { path: string; sha256: string }>> {
    const manifest: Record<string, { path: string; sha256: string }> = {};
    for (const [key, name] of Object.entries(TEMPLATE_NAMES)) {
      if (!name) continue;
      const path = join(this.templateDirectory, name);
      try {
        const bytes = await readFile(path);
        manifest[key] = { path, sha256: createHash("sha256").update(bytes).digest("hex") };
      } catch {
        // Each selected generator reports its own missing template error.
      }
    }
    return manifest;
  }

  private async createBatchDirectory(draft: ReportDraft): Promise<string> {
    const now = new Date();
    const stamp = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const base = `${draft.year}-${String(draft.month).padStart(2, "0")}_${draft.fillDate}_${stamp}`;
    for (let index = 1; index < 1000; index += 1) {
      const directory = join(draft.outputDirectory, index === 1 ? base : `${base}-${index}`);
      try {
        await mkdir(directory);
        return directory;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
      }
    }
    throw new Error("无法创建唯一导出批次目录");
  }

  private async buildWorkReport(draft: ReportDraft, outputPath: string): Promise<void> {
    const template = join(this.templateDirectory, TEMPLATE_NAMES.workReport!);
    const zip = new PizZip(await readFile(template));
    const document = zip.file("word/document.xml");
    if (!document) throw new Error("工作报表模板缺少 word/document.xml");
    const replacements: Record<string, string> = {
      "[mouth]": String(draft.month),
      "[name]": draft.filler,
      "[date]": chineseDate(draft.fillDate),
      "[work1]": draft.workItems[0],
      "[work2]": draft.workItems[1],
      "[work3]": draft.workItems[2],
      "[question1]": draft.questions[0],
      "[question2]": draft.questions[1],
      "[question3]": draft.questions[2],
      "[think1]": draft.reflections[0],
      "[think2]": draft.reflections[1],
      "[think3]": draft.reflections[2],
      "[plan1]": draft.plans[0],
      "[plan2]": draft.plans[1],
      "[plan3]": draft.plans[2],
      "[advice]": draft.advice,
    };
    zip.file("word/document.xml", replaceTokens(document.asText(), replacements));
    await writeFile(outputPath, zip.generate({ type: "nodebuffer", compression: "DEFLATE", mimeType: DOCX_MIME }));
  }

  private async buildPerformanceReport(draft: ReportDraft, snapshot: DashboardSnapshot, outputPath: string): Promise<void> {
    const template = join(this.templateDirectory, TEMPLATE_NAMES.performance!);
    const zip = new PizZip(await readFile(template));
    const document = zip.file("word/document.xml");
    if (!document) throw new Error("绩效模板缺少 word/document.xml");
    const penalty = this.settings.get().latePenaltyPoints;
    let xml = replaceRepeatedRows(
      document.asText(),
      "[int<30]",
      snapshot.members.map((summary) => {
        const score = scoreFor(summary.memberId, draft, summary, penalty);
        return [
          summary.memberName,
          valueOrBlank(score.attendance),
          valueOrBlank(score.hours),
          valueOrBlank(score.self),
          valueOrBlank(score.peer),
          valueOrBlank(score.supervisor),
          valueOrBlank(score.activity),
          valueOrBlank(scoreTotal(score)),
        ];
      }),
    );
    const membersById = new Map(this.members.list().map((member) => [member.id, member]));
    const recommendationRows = draft.recommendations.map((recommendation) => {
      const member = recommendation.memberId ? membersById.get(recommendation.memberId) : undefined;
      const summary = recommendation.memberId ? snapshot.members.find((item) => item.memberId === recommendation.memberId) : undefined;
      const score = member && summary ? scoreFor(member.id, draft, summary, penalty) : null;
      return [member?.name ?? "", member?.studentId ?? "", member?.grade ?? "", member?.major ?? "", member?.employeeNo ?? "", valueOrBlank(score ? scoreTotal(score) : null)];
    });
    xml = replaceRepeatedRows(xml, "[student_id]", recommendationRows);
    const reasons = draft.recommendations.map((recommendation) => recommendation.reason);
    let reasonIndex = 0;
    xml = xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph) => {
      if (!visibleText(paragraph).includes("[reason]")) return paragraph;
      const reason = reasons[reasonIndex] ?? "";
      reasonIndex += 1;
      return replaceTokens(paragraph, { "[reason]": reason });
    });
    xml = replaceTokens(xml, {
      "[mouth]": String(draft.month),
      "[name]": draft.filler,
      "[yyyy年mm月dd日]": chineseDate(draft.fillDate),
    });
    zip.file("word/document.xml", xml);
    await writeFile(outputPath, zip.generate({ type: "nodebuffer", compression: "DEFLATE", mimeType: DOCX_MIME }));
  }

  private async buildWageReport(draft: ReportDraft, snapshot: DashboardSnapshot, outputPath: string): Promise<void> {
    const template = join(this.templateDirectory, TEMPLATE_NAMES.wageAssessment!);
    const zip = new PizZip(await readFile(template));
    const document = zip.file("word/document.xml");
    if (!document) throw new Error("工资考核模板缺少 word/document.xml");
    const members = this.members.list();
    let xml = replaceRepeatedRows(
      document.asText(),
      "[time]",
      members.map((member, index) => {
        return [
          String(index + 1),
          member.employeeNo,
          member.name,
          workloadFor(member.id, draft, snapshot),
          member.college,
          member.role,
          member.phone,
          draft.wageNotes[member.id] ?? "",
          "",
        ];
      }),
    );
    xml = replaceTokens(xml, {
      "[name]:[hours]": "无",
      "[year]": String(draft.year),
      "[mm]": String(draft.month),
      "[mouth]": String(draft.month),
      "[begin:yyyy 年 mm 月 dd 日]": chineseDate(draft.startDate),
      "[end:yyyy 年 mm 月 dd 日]": chineseDate(draft.endDate),
      "[mm月dd日]": `${Number(draft.fillDate.slice(5, 7))}月${Number(draft.fillDate.slice(8, 10))}日`,
      "[name]": draft.filler,
    });
    zip.file("word/document.xml", xml);
    await writeFile(outputPath, zip.generate({ type: "nodebuffer", compression: "DEFLATE", mimeType: DOCX_MIME }));
  }

  private async buildTimeRecord(snapshot: DashboardSnapshot, outputPath: string): Promise<void> {
    const template = join(this.templateDirectory, TEMPLATE_NAMES.timeRecord!);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(template);
    workbook.creator = "网络服务小组签到与月报";
    const summary = workbook.worksheets[0];
    if (!summary) throw new Error("工时记录模板没有工作表");
    summary.name = "工时记录";
    for (const extra of workbook.worksheets.slice(1)) workbook.removeWorksheet(extra.id);
    const records = [...snapshot.records].sort((a, b) => a.actualMemberName.localeCompare(b.actualMemberName, "zh-CN") || a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
    const members = this.members.list();
    const blockCount = 15;
    const dataRows = 37;
    for (let memberIndex = 0; memberIndex < blockCount; memberIndex += 1) {
      const member = members[memberIndex];
      const startColumn = 1 + memberIndex * 9;
      const memberRecords = member ? records.filter((record) => record.actualMemberId === member.id) : [];
      const totalMinutes = memberRecords.reduce((total, record) => total + record.paidMinutes, 0);
      summary.getCell(1, startColumn).value = member ? `员工姓名：${member.name}  工时：${hoursLabel(totalMinutes)}h` : "";
      const headers = ["日期", "计划开始", "计划结束", "工时（h）", "日期", "计划开始", "计划结束", "工时（h）"];
      headers.forEach((header, offset) => { summary.getCell(2, startColumn + offset).value = header; });
      for (let rowNumber = 3; rowNumber <= dataRows + 2; rowNumber += 1) {
        for (let offset = 0; offset < 8; offset += 1) summary.getCell(rowNumber, startColumn + offset).value = null;
      }
      memberRecords.slice(0, dataRows * 2).forEach((record, recordIndex) => {
        const rowNumber = 3 + Math.floor(recordIndex / 2);
        const offset = recordIndex % 2 === 0 ? 0 : 4;
        summary.getCell(rowNumber, startColumn + offset).value = record.date;
        summary.getCell(rowNumber, startColumn + offset + 1).value = record.startTime;
        summary.getCell(rowNumber, startColumn + offset + 2).value = record.endTime;
        const hoursCell = summary.getCell(rowNumber, startColumn + offset + 3);
        hoursCell.value = record.paidMinutes / 60;
        hoursCell.numFmt = '0.##"h"';
      });
    }
    summary.views = [{ state: "frozen", ySplit: 2 }];

    const details = workbook.addWorksheet("签到明细", { views: [{ state: "frozen", ySplit: 1 }] });
    details.addRow(["班次日期", "班次", "计划开始", "计划结束", "原排班人", "实际人员", "真实打卡时间", "迟到状态", "来源", "计薪工时（h）"]);
    for (const record of records) {
      details.addRow([
        record.date,
        record.label,
        record.startTime,
        record.endTime,
        record.scheduledMemberName ?? "空位",
        record.actualMemberName,
        record.punchTime ? new Date(record.punchTime) : "",
        record.lateStatus === "late" ? "迟到" : record.lateStatus === "manual_unjudged" ? "人工补记/未判定" : "正常",
        record.source === "manual" ? "人工补记" : "普通签到",
        record.paidMinutes / 60,
      ]);
    }
    details.eachRow((row) => {
      row.font = { ...row.font, name: "Microsoft YaHei", size: 10 };
      row.alignment = { vertical: "middle", wrapText: true };
    });
    details.getRow(1).font = { name: "Microsoft YaHei", bold: true, color: { argb: "FFFFFFFF" } };
    details.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A73E8" } };
    details.columns.forEach((column, index) => { column.width = [14, 18, 12, 12, 16, 16, 20, 18, 14, 14][index] ?? 14; });
    details.getColumn(10).numFmt = '0.##"h"';
    details.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    details.pageSetup.printArea = `A1:J${details.rowCount}`;
    details.getColumn(7).numFmt = "yyyy-mm-dd hh:mm";
    await workbook.xlsx.writeFile(outputPath);
  }

  private async buildScheduleReport(draft: ReportDraft, outputPath: string): Promise<void> {
    const lines = this.scheduleLines(draft.startDate, draft.endDate);
    const children: Array<Paragraph | Table> = [
      new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: `${draft.year}年${draft.month}月网络中心服务小组排班表`, font: "Microsoft YaHei", bold: true })],
      }),
    ];
    let pastedWorksheetCount = 0;
    const sources = this.store.prepare(`
      SELECT DISTINCT si.source_path, si.source_name, si.imported_at
      FROM shifts s JOIN schedule_imports si ON si.id = s.schedule_import_id
      WHERE s.active = 1 AND s.date BETWEEN ? AND ?
      ORDER BY si.imported_at
    `).all(draft.startDate, draft.endDate) as unknown as Array<{ source_path: string; source_name: string; imported_at: string }>;
    for (const source of sources) {
      try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(source.source_path);
        for (const worksheet of workbook.worksheets) {
          const rows = worksheetRows(worksheet);
          if (rows.length === 0) continue;
          children.push(
            new Paragraph({
              heading: HeadingLevel.HEADING_2,
              children: [new TextRun({ text: sources.length > 1 ? `${source.source_name} · ${worksheet.name}` : worksheet.name, font: "Microsoft YaHei", bold: true })],
            }),
            wordTable(rows[0]!, rows.slice(1)),
          );
          pastedWorksheetCount += 1;
        }
      } catch {
        // 原始文件不可读时，下面使用数据库中的正式排班生成等价表格。
      }
    }
    if (pastedWorksheetCount === 0) {
      const sections = (["desk", "maintenance", "weekend"] as const).map((kind) => ({
        title: kind === "desk" ? "工作日坐班" : kind === "maintenance" ? "维修班" : "周末坐班",
        rows: lines.filter((line) => line.kind === kind),
      }));
      for (const section of sections) {
        if (section.rows.length === 0) continue;
        children.push(
          new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: section.title, font: "Microsoft YaHei", bold: true })] }),
          wordTable(
            ["日期", "星期", "时间", "负责人"],
            section.rows.map((line) => [
              line.date,
              `星期${["日", "一", "二", "三", "四", "五", "六"][new Date(`${line.date}T00:00:00`).getDay()]}`,
              `${line.startTime}-${line.endTime}`,
              line.people.join("、"),
            ]),
          ),
        );
      }
    }
    const document = new Document({
      sections: [
        {
          properties: {
            page: {
              size: { width: 16838, height: 11906, orientation: PageOrientation.LANDSCAPE },
              margin: { top: 720, bottom: 720, left: 720, right: 720 },
            },
          },
          children,
        },
      ],
    });
    await writeFile(outputPath, await Packer.toBuffer(document));
  }

  private async validateGeneratedFile(path: string, type: "docx" | "xlsx"): Promise<void> {
    const info = await stat(path);
    if (info.size < 1_000) throw new Error("生成文件过小或为空");
    if (type === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(path);
      if (workbook.worksheets.length < 2) throw new Error("工时表缺少签到明细工作表");
      return;
    }
    const zip = new PizZip(await readFile(path));
    const document = zip.file("word/document.xml");
    if (!document) throw new Error("DOCX 结构无效");
    const text = visibleText(document.asText());
    if (/\[(?:mouth|name|date|work\d|question\d|think\d|plan\d|advice|int<|sum|student_id|grade|major|reason|time|college name|phone_number|year|mm|begin:|end:|hours)/i.test(text)) {
      throw new Error("生成文件仍包含未替换占位符");
    }
  }
}
