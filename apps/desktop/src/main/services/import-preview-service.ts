import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ImportPreview } from "../../shared/contracts";
import { formatLocalDateTimeKey } from "../../domain/time";
import type { DatabaseStore } from "../database";
import { parseScheduleWorkbook } from "./schedule-parser";
import type { ScheduleService } from "./schedule-service";
import type { MemberService } from "./member-service";
import type { SettingsService } from "./settings-service";

type Pending = {
  preview: ImportPreview;
  path: string;
  hash: string;
  month: string;
  effectiveDate: string;
};
export class ImportPreviewService {
  private pending = new Map<string, Pending>();
  private applying = false;
  private completed = new Map<string, { request: string; message: string }>();
  constructor(
    private store: DatabaseStore,
    private schedule: ScheduleService,
    private members: MemberService,
    private settings: SettingsService,
  ) {}

  async preview(
    path: string,
    input: {
      kind: "schedule" | "members";
      month: string;
      effectiveDate: string;
    },
  ): Promise<ImportPreview> {
    this.store.captureSources();
    const bytes = await readFile(path);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const revision = this.store.dataRevision();
    const preview: ImportPreview = {
      id: randomUUID(),
      kind: input.kind,
      fileName: basename(path),
      dataRevision: revision,
      additions: [],
      updates: [],
      warnings: [],
      conflicts: [],
    };
    if (input.kind === "members") {
      const inputs = await this.members.parseWorkbook(path);
      for (const member of inputs) {
        const matches = this.members.findByExactName(member.name);
        if (matches.length > 1)
          preview.conflicts.push({
            id: member.name,
            description: `同名成员“${member.name}”无法唯一匹配，请先整理成员资料`,
            canReplace: false,
          });
        else
          (matches.length ? preview.updates : preview.additions).push(
            member.name,
          );
      }
      if (new Set(inputs.map((m) => m.name)).size !== inputs.length)
        preview.warnings.push("文件有重复姓名，应用前请先修正源文件");
    } else {
      const parsed = await parseScheduleWorkbook(path, input.month);
      preview.warnings.push(...parsed.warnings);
      for (const name of new Set(
        parsed.shifts
          .flatMap((s) => s.people)
          .filter((n): n is string => Boolean(n)),
      ))
        if (this.members.findByExactName(name).length > 1)
          preview.conflicts.push({
            id: "member:" + name,
            description: "同名成员“" + name + "”无法唯一对应，请先整理成员资料",
            canReplace: false,
          });
      const rows = this.store
        .prepare(
          `SELECT s.id,s.date,s.kind,s.start_time,s.end_time,s.revision,s.cancelled,src.payload_json,
        EXISTS(SELECT 1 FROM attendance_records ar WHERE ar.shift_id=s.id) AS historical,
        EXISTS(SELECT 1 FROM shift_slots ss WHERE ss.shift_id=s.id AND ss.slot_source='manual' AND ss.is_vacant=0) AS staffing,
        EXISTS(SELECT 1 FROM leave_records lr JOIN shift_slots ss ON ss.id=lr.shift_slot_id WHERE ss.shift_id=s.id AND lr.status='active') AS leaves
        FROM shifts s JOIN schedule_imports si ON si.id=s.schedule_import_id LEFT JOIN shift_sources src ON src.shift_id=s.id
        WHERE si.source_type='file' AND (s.active=1 OR s.cancelled=1) AND (s.date>=? AND s.date LIKE ? OR json_extract(src.payload_json,'$.date')>=? AND json_extract(src.payload_json,'$.date') LIKE ?)`,
        )
        .all(
          input.effectiveDate,
          `${input.month}-%`,
          input.effectiveDate,
          `${input.month}-%`,
        ) as Array<Record<string, string | number | null>>;
      for (const row of rows) {
        const original = row.payload_json
          ? JSON.parse(String(row.payload_json))
          : {
              date: row.date,
              kind: row.kind,
              startTime: row.start_time,
              endTime: row.end_time,
            };
        const match = parsed.shifts.find(
          (d) =>
            d.date === original.date &&
            d.kind === original.kind &&
            d.startTime === original.startTime &&
            d.endTime === original.endTime,
        );
        const changed =
          Boolean(row.cancelled) ||
          original.date !== row.date ||
          original.startTime !== row.start_time ||
          original.endTime !== row.end_time ||
          row.staffing ||
          row.leaves;
        const historical =
          Boolean(row.historical) ||
          `${row.date}T${row.end_time}` <= formatLocalDateTimeKey(new Date());
        if (changed || historical || !match)
          preview.conflicts.push({
            id: String(row.id),
            description: `${row.date} ${row.start_time}-${row.end_time}：${historical ? "包含历史记录或已结束，保留原安排" : changed ? "包含单次调整、请假或临时人员" : "新文件中没有对应班次"}`,
            canReplace: !historical && !row.leaves,
          });
      }
      for (const shift of parsed.shifts.filter(
        (s) => s.date >= input.effectiveDate,
      )) {
        const matches = rows.filter((r) => {
          const original = r.payload_json
            ? JSON.parse(String(r.payload_json))
            : {
                date: r.date,
                kind: r.kind,
                startTime: r.start_time,
                endTime: r.end_time,
              };
          return (
            original.date === shift.date &&
            original.kind === shift.kind &&
            original.startTime === shift.startTime &&
            original.endTime === shift.endTime
          );
        });
        const text = `${shift.date} ${shift.label} ${shift.startTime}-${shift.endTime} · ${shift.people.join("、")}`;
        (matches.length ? preview.updates : preview.additions).push(text);
        if (matches.length > 1) {
          preview.warnings.push(
            `${text} 存在多个旧班次，保留旧班次并跳过冲突的新建项目`,
          );
          for (const row of matches) {
            const conflict = preview.conflicts.find(
              (c) => c.id === String(row.id),
            );
            if (conflict) {
              conflict.canReplace = false;
              conflict.description += "；原始关系不唯一，请确认保留";
            } else
              preview.conflicts.push({
                id: String(row.id),
                description: `${row.date} ${row.start_time}：原始关系不唯一，请确认保留后再整理`,
                canReplace: false,
              });
          }
        }
      }
    }
    if (
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex") !== hash
    )
      throw new Error("解析期间文件已变化，请重新预览");
    if (this.store.dataRevision() !== revision)
      throw new Error("解析期间数据已变化，请重新预览");
    this.pending.clear();
    this.pending.set(preview.id, {
      preview,
      path,
      hash,
      month: input.month,
      effectiveDate: input.effectiveDate,
    });
    return preview;
  }

  async apply(input: {
    id: string;
    resolutions: Record<string, "keep" | "replace">;
  }): Promise<{ message: string }> {
    const completed = this.completed.get(input.id);
    if (completed) {
      if (completed.request !== JSON.stringify(input))
        throw new Error("该预览已按另一组处理决定应用");
      return { message: completed.message };
    }
    if (this.applying) throw new Error("导入正在应用，请等待完成");
    const pending = this.pending.get(input.id);
    if (!pending) throw new Error("导入预览已过期，请重新选择文件");
    for (const conflict of pending.preview.conflicts) {
      if (!input.resolutions[conflict.id])
        throw new Error("请先逐项处理导入冲突");
      if (input.resolutions[conflict.id] === "replace" && !conflict.canReplace)
        throw new Error("历史安排或关联请假不能直接替换");
    }
    if (pending.preview.conflicts.some((c) => c.id.startsWith("member:")))
      throw new Error("请先处理同名成员关系，再重新预览");
    if (
      pending.preview.kind === "members" &&
      (pending.preview.conflicts.length || pending.preview.warnings.length)
    )
      throw new Error("请先修正重复姓名或同名冲突，再重新预览");
    this.applying = true;
    try {
      const hash = createHash("sha256")
        .update(await readFile(pending.path))
        .digest("hex");
      if (
        hash !== pending.hash ||
        this.store.dataRevision() !== pending.preview.dataRevision
      )
        throw new Error("文件或数据已变化，请重新预览后应用");
      let message: string;
      if (pending.preview.kind === "schedule") {
        const result = await this.schedule.import(
          pending.path,
          pending.month,
          pending.effectiveDate,
          this.settings.get(),
          input.resolutions,
          pending.preview.dataRevision,
          pending.hash,
        );
        message = `排班已应用：${result.shiftCount} 个班次、${result.slotCount} 个席位`;
      } else {
        const result = await this.members.importWorkbook(
          pending.path,
          pending.preview.dataRevision,
          pending.hash,
        );
        message = `成员已应用：新增 ${result.created}、更新 ${result.updated}`;
      }
      this.pending.delete(input.id);
      this.completed.set(input.id, { request: JSON.stringify(input), message });
      if (this.completed.size > 100)
        this.completed.delete(this.completed.keys().next().value!);
      return { message };
    } finally {
      this.applying = false;
    }
  }
}
