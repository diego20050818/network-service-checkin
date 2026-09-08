import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ScheduleImportResult, Settings } from "../../shared/contracts";
import { formatLocalDateTimeKey } from "../../domain/time";
import type { DatabaseStore } from "../database";
import type { MemberService } from "./member-service";
import { parseScheduleWorkbook } from "./schedule-parser";

type Definition = Awaited<
  ReturnType<typeof parseScheduleWorkbook>
>["shifts"][number];
type OldShift = {
  id: string;
  date: string;
  kind: string;
  start_time: string;
  end_time: string;
  payload_json: string | null;
  historical: number;
  adjusted: number;
  cancelled: number;
};
const keyOf = (d: {
  date: string;
  kind: string;
  startTime: string;
  endTime: string;
}) => [d.date, d.kind, d.startTime, d.endTime].join("|");

export class ScheduleService {
  constructor(
    private store: DatabaseStore,
    private members: MemberService,
    private scheduleSourceDirectory: string,
  ) {}

  async import(
    filePath: string,
    month: string,
    effectiveDate: string,
    settings: Settings,
    resolutions: Record<string, "keep" | "replace"> = {},
    expectedRevision?: number,
    expectedHash?: string,
  ): Promise<ScheduleImportResult> {
    const file = await readFile(filePath);
    const hash = createHash("sha256").update(file).digest("hex");
    const parsed = await parseScheduleWorkbook(filePath, month);
    if (
      createHash("sha256")
        .update(await readFile(filePath))
        .digest("hex") !== hash ||
      (expectedHash && expectedHash !== hash)
    )
      throw new Error("源文件已变化，请重新预览");
    const duplicate = this.store
      .prepare(
        "SELECT id,source_name FROM schedule_imports WHERE source_sha256=? AND month=? AND source_type='file'",
      )
      .get(hash, month) as { id: string; source_name: string } | undefined;
    const importId = duplicate?.id ?? randomUUID();
    const stamp = new Date().toISOString();
    const definitions = parsed.shifts.filter((s) => s.date >= effectiveDate);
    const createdMembers: string[] = [];
    const warnings = [...parsed.warnings];
    await mkdir(this.scheduleSourceDirectory, { recursive: true });
    const storedPath = join(
      this.scheduleSourceDirectory,
      month + "_" + importId + "_" + basename(filePath),
    );
    if (!duplicate) {
      await copyFile(filePath, storedPath);
      if (
        createHash("sha256")
          .update(await readFile(storedPath))
          .digest("hex") !== hash
      )
        throw new Error("归档文件已变化，请重新预览");
    }
    if (
      expectedRevision !== undefined &&
      this.store.dataRevision() !== expectedRevision
    )
      throw new Error("数据已变化，请重新预览");
    let changed = 0;
    this.store.transaction(() => {
      this.store.captureSources();
      if (!duplicate)
        this.store
          .prepare(
            `INSERT INTO schedule_imports(id,source_name,source_path,source_sha256,month,effective_date,imported_at,warnings_json,active)
        VALUES(?,?,?,?,?,?,?,?,1)`,
          )
          .run(
            importId,
            basename(filePath),
            storedPath,
            hash,
            month,
            effectiveDate,
            stamp,
            JSON.stringify(warnings),
          );
      const old = this.store
        .prepare(
          `SELECT s.id,s.date,s.kind,s.start_time,s.end_time,s.cancelled,src.payload_json,
        EXISTS(SELECT 1 FROM attendance_records ar WHERE ar.shift_id=s.id) AS historical,
        (EXISTS(SELECT 1 FROM shift_slots ss WHERE ss.shift_id=s.id AND ss.slot_source='manual' AND ss.is_vacant=0)
        OR EXISTS(SELECT 1 FROM leave_records lr JOIN shift_slots ss ON ss.id=lr.shift_slot_id WHERE ss.shift_id=s.id AND lr.status='active')) AS adjusted
        FROM shifts s JOIN schedule_imports si ON si.id=s.schedule_import_id LEFT JOIN shift_sources src ON src.shift_id=s.id
        WHERE si.source_type='file' AND (s.active=1 OR s.cancelled=1) AND
          ((s.date>=? AND s.date LIKE ?) OR (json_extract(src.payload_json,'$.date')>=? AND json_extract(src.payload_json,'$.date') LIKE ?))`,
        )
        .all(
          effectiveDate,
          month + "-%",
          effectiveDate,
          month + "-%",
        ) as unknown as OldShift[];
      const original = (s: OldShift) =>
        s.payload_json
          ? JSON.parse(s.payload_json)
          : {
              date: s.date,
              kind: s.kind,
              startTime: s.start_time,
              endTime: s.end_time,
            };
      const groups = new Map<string, OldShift[]>();
      for (const s of old) {
        const k = keyOf(original(s));
        groups.set(k, [...(groups.get(k) ?? []), s]);
      }
      const matched = new Set<string>();
      for (const d of definitions) {
        const candidates = groups.get(keyOf(d)) ?? [];
        if (candidates.length > 1) {
          warnings.push(
            d.date + " " + d.startTime + " 有多个对应旧班次，保留旧安排",
          );
          candidates.forEach((s) => matched.add(s.id));
          continue;
        }
        const previous = candidates[0];
        if (previous) {
          matched.add(previous.id);
          if (duplicate) continue;
          const base = original(previous);
          const modified =
            Boolean(previous.adjusted) ||
            Boolean(previous.cancelled) ||
            base.date !== previous.date ||
            base.startTime !== previous.start_time ||
            base.endTime !== previous.end_time;
          const locked =
            Boolean(previous.historical) ||
            previous.date + "T" + previous.end_time <=
              formatLocalDateTimeKey(new Date());
          if (
            locked ||
            resolutions[previous.id] === "keep" ||
            (modified && resolutions[previous.id] !== "replace")
          ) {
            warnings.push(
              previous.date + " " + previous.start_time + " 保留已有执行安排",
            );
            continue;
          }
          const people = d.people.map((name) => {
            const ensured = this.members.ensureMinimal(name!);
            if (ensured.created) createdMembers.push(ensured.member.name);
            return ensured.member.id;
          });
          const slots = this.store
            .prepare(
              "SELECT id,scheduled_member_id FROM shift_slots WHERE shift_id=? AND is_vacant=0 ORDER BY position",
            )
            .all(previous.id) as Array<{
            id: string;
            scheduled_member_id: string;
          }>;
          if (
            this.store
              .prepare(
                "SELECT lr.id FROM leave_records lr JOIN shift_slots ss ON ss.id=lr.shift_slot_id WHERE ss.shift_id=? AND lr.status='active'",
              )
              .get(previous.id)
          )
            throw new Error("请先处理关联请假");
          for (const slot of slots)
            if (!people.includes(slot.scheduled_member_id))
              this.store
                .prepare("UPDATE shift_slots SET is_vacant=1 WHERE id=?")
                .run(slot.id);
          for (const memberId of people)
            if (!slots.some((s) => s.scheduled_member_id === memberId))
              this.insertSlot(previous.id, memberId);
          this.store
            .prepare(
              `UPDATE shifts SET active=1,cancelled=0,schedule_import_id=?,date=?,kind=?,label=?,start_time=?,end_time=?,paid_minutes=?,required_slots=?,attendance_mode=?,late_threshold_minutes=? WHERE id=?`,
            )
            .run(
              importId,
              d.date,
              d.kind,
              d.label,
              d.startTime,
              d.endTime,
              d.paidMinutes,
              people.length,
              settings.attendanceMode,
              settings.lateThresholdMinutes,
              previous.id,
            );
          changed++;
        } else {
          const present = this.store
            .prepare(
              `SELECT s.id FROM shifts s LEFT JOIN shift_sources src ON src.shift_id=s.id WHERE s.schedule_import_id=? AND
            ((s.date=? AND s.kind=? AND s.start_time=? AND s.end_time=?) OR
            (json_extract(src.payload_json,'$.date')=? AND json_extract(src.payload_json,'$.kind')=? AND json_extract(src.payload_json,'$.startTime')=? AND json_extract(src.payload_json,'$.endTime')=?))`,
            )
            .get(
              importId,
              d.date,
              d.kind,
              d.startTime,
              d.endTime,
              d.date,
              d.kind,
              d.startTime,
              d.endTime,
            );
          if (present) continue;
          this.insertDefinition(importId, d, settings, stamp, createdMembers);
          changed++;
        }
      }
      if (!duplicate)
        for (const previous of old.filter((s) => !matched.has(s.id))) {
          const locked =
            previous.historical ||
            previous.date + "T" + previous.end_time <=
              formatLocalDateTimeKey(new Date());
          if (locked || resolutions[previous.id] !== "replace") {
            warnings.push(
              previous.date + " " + previous.start_time + " 保留未匹配安排",
            );
            continue;
          }
          if (
            this.store
              .prepare(
                "SELECT lr.id FROM leave_records lr JOIN shift_slots ss ON ss.id=lr.shift_slot_id WHERE ss.shift_id=? AND lr.status='active'",
              )
              .get(previous.id)
          )
            throw new Error("请先处理关联请假");
          this.store
            .prepare("UPDATE shifts SET active=0,cancelled=1 WHERE id=?")
            .run(previous.id);
        }
      this.store.captureSources();
      this.store
        .prepare(
          "INSERT OR IGNORE INTO formal_schedule_versions(import_id,payload_json) VALUES(?,?)",
        )
        .run(importId, JSON.stringify(definitions));
      this.store
        .prepare("UPDATE schedule_imports SET warnings_json=? WHERE id=?")
        .run(JSON.stringify(warnings), importId);
    });
    return {
      importId,
      fileName: duplicate?.source_name ?? basename(filePath),
      month,
      effectiveDate,
      shiftCount: definitions.length,
      slotCount: definitions.reduce((n, s) => n + s.people.length, 0),
      createdMembers: [...new Set(createdMembers)],
      warnings,
      duplicate: Boolean(duplicate) && changed === 0,
    };
  }
  private insertSlot(shiftId: string, memberId: string): void {
    const position = Number(
      this.store
        .prepare(
          "SELECT COALESCE(MAX(position),0)+1 AS n FROM shift_slots WHERE shift_id=?",
        )
        .get(shiftId)!.n,
    );
    this.store
      .prepare(
        "INSERT INTO shift_slots(id,shift_id,position,scheduled_member_id) VALUES(?,?,?,?)",
      )
      .run(randomUUID(), shiftId, position, memberId);
  }
  private insertDefinition(
    importId: string,
    d: Definition,
    settings: Settings,
    createdAt: string,
    createdMembers: string[],
  ): void {
    const id = randomUUID();
    this.store
      .prepare(
        `INSERT INTO shifts(id,schedule_import_id,date,kind,label,start_time,end_time,paid_minutes,required_slots,attendance_mode,late_threshold_minutes,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        importId,
        d.date,
        d.kind,
        d.label,
        d.startTime,
        d.endTime,
        d.paidMinutes,
        d.people.length,
        settings.attendanceMode,
        settings.lateThresholdMinutes,
        createdAt,
      );
    for (const name of d.people) {
      const ensured = this.members.ensureMinimal(name!);
      if (ensured.created) createdMembers.push(ensured.member.name);
      this.insertSlot(id, ensured.member.id);
    }
  }
}
