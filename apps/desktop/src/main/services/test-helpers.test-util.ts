import { randomUUID } from "node:crypto";
import type { AttendanceMode, ShiftKind } from "../../shared/contracts";
import type { DatabaseStore } from "../database";
import type { MemberService } from "./member-service";

export function addScheduleImport(store: DatabaseStore, month = "2026-09"): string {
  const id = randomUUID();
  store
    .prepare(`
      INSERT INTO schedule_imports(id, source_name, source_path, source_sha256, month, effective_date, imported_at, warnings_json, active)
      VALUES (?, 'fixture.xlsx', 'fixture.xlsx', ?, ?, ?, ?, '[]', 1)
    `)
    .run(id, randomUUID().replace(/-/g, ""), month, `${month}-01`, new Date().toISOString());
  return id;
}

export function addShift(
  store: DatabaseStore,
  members: MemberService,
  input: {
    importId: string;
    date: string;
    kind: ShiftKind;
    startTime: string;
    endTime: string;
    paidMinutes: number;
    people: Array<string | null>;
    mode?: AttendanceMode;
    threshold?: number;
  },
): { shiftId: string; slotIds: string[]; memberIds: Record<string, string> } {
  const shiftId = randomUUID();
  const now = new Date().toISOString();
  store
    .prepare(`
      INSERT INTO shifts(
        id, schedule_import_id, date, kind, label, start_time, end_time, paid_minutes,
        required_slots, attendance_mode, late_threshold_minutes, active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `)
    .run(
      shiftId,
      input.importId,
      input.date,
      input.kind,
      input.kind === "maintenance" ? "维修班" : input.kind === "weekend" ? "周末坐班" : "工作日坐班",
      input.startTime,
      input.endTime,
      input.paidMinutes,
      input.people.length,
      input.mode ?? "lenient",
      input.threshold ?? 15,
      now,
    );
  const slotIds: string[] = [];
  const memberIds: Record<string, string> = {};
  input.people.forEach((name, index) => {
    const slotId = randomUUID();
    slotIds.push(slotId);
    const memberId = name ? members.ensureMinimal(name).member.id : null;
    if (name && memberId) memberIds[name] = memberId;
    store.prepare("INSERT INTO shift_slots(id, shift_id, position, scheduled_member_id, is_vacant) VALUES (?, ?, ?, ?, ?)").run(
      slotId,
      shiftId,
      index + 1,
      memberId,
      memberId ? 0 : 1,
    );
  });
  return { shiftId, slotIds, memberIds };
}

