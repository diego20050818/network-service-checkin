import { randomUUID } from "node:crypto";
import type {
  AttendanceAction,
  OccurrenceInput,
  OccurrenceView,
  OperationEntry,
  OperationResult,
  OvertimeInput,
} from "../../shared/contracts";
import { formatLocalDateTimeKey, paidMinutesBetween } from "../../domain/time";
import type { DatabaseStore } from "../database";
import type { AttendanceService } from "./attendance-service";
import type { AdjustmentService } from "./adjustment-service";
import type { MemberService } from "./member-service";
import { SettingsService } from "./settings-service";

type Row = Record<string, string | number | null>;
type State = {
  shifts: Row[];
  shift_slots: Row[];
  attendance_records: Row[];
  leave_records: Row[];
};
type History = {
  id: string;
  label: string;
  request_json: string;
  shift_ids_json: string;
  before_json: string;
  after_json: string;
  result_json: string;
  created_at: string;
  undone_at: string | null;
};

export class OccurrenceService {
  constructor(
    private store: DatabaseStore,
    private attendance: AttendanceService,
    private adjustments: AdjustmentService,
    private members: MemberService,
  ) {}

  get(id: string): OccurrenceView {
    const row = this.store
      .prepare("SELECT * FROM shifts WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) throw new Error("班次不存在");
    // Read cancelled occurrences without changing their persisted status.
    const shift = this.attendance.getShiftIncludingInactive(id)!;
    const hasHistory = Boolean(
      this.store
        .prepare("SELECT id FROM attendance_records WHERE shift_id = ? LIMIT 1")
        .get(id),
    );
    const source = this.store
      .prepare("SELECT payload_json FROM shift_sources WHERE shift_id = ?")
      .get(id) as { payload_json: string } | undefined;
    const recovery = this.store
      .prepare(
        "SELECT * FROM operation_history WHERE label='取消本次班次' AND undone_at IS NULL AND EXISTS(SELECT 1 FROM json_each(shift_ids_json) WHERE value=?) ORDER BY created_at DESC LIMIT 1",
      )
      .get(id) as History | undefined;
    const removedSlots = this.store
      .prepare(
        "SELECT ss.id, COALESCE(m.name,'未安排') AS memberName FROM shift_slots ss LEFT JOIN members m ON m.id=ss.scheduled_member_id WHERE ss.shift_id=? AND ss.is_vacant=1 AND ss.slot_source='manual' AND ss.slot_role='staff' ORDER BY ss.position",
      )
      .all(id) as Array<{ id: string; memberName: string }>;
    return {
      ...shift,
      recoveryOperationId:
        recovery && this.entry(recovery).canUndo ? recovery.id : null,
      removedSlots,
      revision: Number(row.revision),
      active: row.active === 1,
      hasAttendanceHistory: hasHistory,
      editable:
        row.active === 1 &&
        !hasHistory &&
        `${shift.date}T${shift.endTime}` > formatLocalDateTimeKey(new Date()),
      origin: source ? "imported" : "manual",
      original: source ? JSON.parse(source.payload_json) : null,
    };
  }

  list(filters: {
    startDate: string;
    endDate: string;
    includeCancelled?: boolean;
  }): OccurrenceView[] {
    this.store.captureSources();
    const rows = this.store
      .prepare(
        `SELECT id FROM shifts WHERE date BETWEEN ? AND ? AND (active = 1 ${filters.includeCancelled ? "OR cancelled = 1" : ""}) ORDER BY date, start_time, id`,
      )
      .all(filters.startDate, filters.endDate) as Array<{ id: string }>;
    return rows.map((row) => this.get(row.id));
  }

  save(input: OccurrenceInput): OperationResult {
    const replay = this.replay(input.operationId, input);
    if (replay) return replay;
    const shiftId = input.id ?? randomUUID();
    return this.run(
      input.operationId,
      input.id ? "修改单次班次" : "新建单次班次",
      input,
      [shiftId],
      () => {
        const minutes = paidMinutesBetween(input.startTime, input.endTime);
        if (
          new Set(input.memberIds).size !== input.memberIds.length ||
          !input.memberIds.length
        )
          throw new Error("班次至少安排一人，同一班不能重复安排同一人");
        for (const memberId of input.memberIds)
          if (!this.members.get(memberId)?.active)
            throw new Error("成员不存在或已停用");
        if (
          `${input.date}T${input.endTime}` <= formatLocalDateTimeKey(new Date())
        )
          throw new Error("不能新建或移到已结束时段，请通过记录页补记或纠错");
        if (input.id) {
          if (input.expectedRevision === undefined)
            throw new Error("编辑已有班次必须携带预期版本");
          const existing = this.get(input.id);
          this.expectRevision(input.id, input.expectedRevision);
          if (!existing.editable)
            throw new Error(
              "已有签到历史或已结束的班次不能修改计划，请使用记录更正",
            );
          const changedTime =
            existing.date !== input.date ||
            existing.startTime !== input.startTime ||
            existing.endTime !== input.endTime;
          if (
            existing.slots.some(
              (slot) =>
                slot.leave?.replacementMemberId &&
                input.memberIds.includes(slot.leave.replacementMemberId),
            )
          )
            throw new Error("代班人员已在本班次中，请先处理关联请假");
          const leaves = this.store
            .prepare(
              "SELECT lr.id FROM leave_records lr JOIN shift_slots ss ON ss.id = lr.shift_slot_id WHERE ss.shift_id = ? AND lr.status = 'active'",
            )
            .all(input.id);
          if (
            changedTime &&
            (leaves.length ||
              `${existing.date}T${existing.startTime}` <=
                formatLocalDateTimeKey(new Date())) &&
            !input.confirmImpact
          )
            throw new Error(
              "需要确认：本次时间修改将影响进行中的班次或关联请假",
            );
          if (existing.workType !== input.workType)
            throw new Error("已有班次不能转换计薪类型，请复制后新建");
          this.store
            .prepare(
              "UPDATE shifts SET date=?, start_time=?, end_time=?, paid_minutes=?, kind=?, label=?, note=? WHERE id=?",
            )
            .run(
              input.date,
              input.startTime,
              input.endTime,
              minutes,
              input.kind,
              input.label.trim(),
              input.note.trim(),
              input.id,
            );
          const retained = new Set<string>();
          for (const slot of existing.slots) {
            if (
              slot.scheduledMemberId &&
              input.memberIds.includes(slot.scheduledMemberId)
            ) {
              retained.add(slot.scheduledMemberId);
              continue;
            }
            if (slot.leave)
              throw new Error("请先处理该人员的关联请假，再修改人员安排");
            this.store
              .prepare("UPDATE shift_slots SET is_vacant=1 WHERE id=?")
              .run(slot.id);
          }
          for (const memberId of input.memberIds.filter(
            (id) => !retained.has(id),
          ))
            this.addSlot(input.id, memberId, input.workType);
        } else {
          const settings = new SettingsService(this.store).get();
          const importId = randomUUID();
          this.store
            .prepare(
              `INSERT INTO schedule_imports(id,source_name,source_path,source_sha256,month,effective_date,imported_at,source_type)
          VALUES(?,'单次安排','',?,?,?,?,'system')`,
            )
            .run(
              importId,
              `occurrence-${importId}`,
              input.date.slice(0, 7),
              input.date,
              new Date().toISOString(),
            );
          this.store
            .prepare(
              `INSERT INTO shifts(id,schedule_import_id,date,kind,label,start_time,end_time,paid_minutes,required_slots,attendance_mode,late_threshold_minutes,created_at,work_type,note)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              shiftId,
              importId,
              input.date,
              input.kind,
              input.label.trim(),
              input.startTime,
              input.endTime,
              minutes,
              input.memberIds.length,
              settings.attendanceMode,
              settings.lateThresholdMinutes,
              new Date().toISOString(),
              input.workType,
              input.note.trim(),
            );
          for (const memberId of input.memberIds)
            this.addSlot(shiftId, memberId, input.workType);
        }
        this.sync(shiftId);
        return [];
      },
    );
  }

  cancel(input: {
    id: string;
    expectedRevision: number;
    operationId: string;
  }): OperationResult {
    return this.run(
      input.operationId,
      "取消本次班次",
      input,
      [input.id],
      () => {
        this.expectRevision(input.id, input.expectedRevision);
        const shift = this.get(input.id);
        if (!shift.editable)
          throw new Error("已有签到历史或已结束的班次不能直接取消");
        if (shift.slots.some((s) => s.leave))
          throw new Error("请先处理关联请假再取消本次安排");
        this.store
          .prepare("UPDATE shifts SET active=0, cancelled=1 WHERE id=?")
          .run(input.id);
        if (shift.workType === "overtime")
          this.store
            .prepare("UPDATE shift_slots SET is_vacant=1 WHERE shift_id=?")
            .run(input.id);
        return [];
      },
    );
  }

  action(input: AttendanceAction): OperationResult {
    const labels = {
      createLeave: "登记请假",
      updateLeave: "修改请假",
      cancelLeave: "撤销请假",
      restoreLeave: "恢复请假",
      cancelOvertime: "取消加班",
      restoreOvertime: "恢复加班",
      manual: "人工补记",
      checkin: "签到",
      addStaff: "添加办公人员",
      removeStaff: "移除临时席位",
      restoreStaff: "恢复临时席位",
      revokeAndRemove: "撤销签到并移除席位",
      correct: "更正实际人员",
      revoke: "撤销签到",
      restore: "恢复签到",
    };
    return this.run(
      input.operationId,
      labels[input.type],
      input,
      [input.shiftId],
      () => {
        this.expectRevision(input.shiftId, input.expectedRevision);
        if (
          "slotId" in input &&
          !this.store
            .prepare("SELECT id FROM shift_slots WHERE id=? AND shift_id=?")
            .get(input.slotId, input.shiftId)
        )
          throw new Error("席位与班次不匹配");
        if ("recordId" in input) {
          const record = this.attendance.getRecord(input.recordId);
          if (
            record.shiftId !== input.shiftId ||
            ("slotId" in input && record.slotId !== input.slotId)
          )
            throw new Error("签到记录与席位不匹配");
        }
        if (
          "leaveId" in input &&
          !this.store
            .prepare(
              "SELECT lr.id FROM leave_records lr JOIN shift_slots ss ON ss.id=lr.shift_slot_id WHERE lr.id=? AND ss.shift_id=?",
            )
            .get(input.leaveId, input.shiftId)
        )
          throw new Error("请假与班次不匹配");
        switch (input.type) {
          case "createLeave":
            this.adjustments.createLeave(input);
            break;
          case "updateLeave":
            this.adjustments.updateLeave(input.leaveId, input);
            break;
          case "cancelLeave":
            this.adjustments.cancelLeave(input.leaveId);
            break;
          case "restoreLeave":
            this.adjustments.restoreLeave(input.leaveId);
            break;
          case "cancelOvertime":
            this.adjustments.cancelOvertime(input.slotId);
            break;
          case "restoreOvertime":
            this.adjustments.restoreOvertime(input.slotId);
            break;
          case "manual":
            return [this.attendance.addManual(input).id];
          case "checkin":
            return this.attendance
              .checkIn(input.shiftId, input.selections)
              .filter((r) => !r.alreadyExisted)
              .map((r) => r.record.id);
          case "addStaff":
            this.adjustments.addShiftStaff(input);
            break;
          case "removeStaff":
            this.adjustments.removeShiftStaff(input.slotId);
            break;
          case "restoreStaff":
            this.restoreSlot(input.slotId);
            break;
          case "revokeAndRemove":
            this.attendance.revoke(input.recordId);
            this.adjustments.removeShiftStaff(input.slotId);
            break;
          case "correct":
            this.attendance.correctMember(input.recordId, input.memberId);
            break;
          case "revoke":
            this.attendance.revoke(input.recordId);
            break;
          case "restore": {
            const record = this.attendance.getRecord(input.recordId);
            if (
              this.store
                .prepare(
                  "SELECT id FROM shift_slots WHERE id=? AND is_vacant=1",
                )
                .get(record.slotId)
            ) {
              if (record.workType === "overtime")
                this.adjustments.restoreOvertime(record.slotId);
              else this.restoreSlot(record.slotId);
            }
            this.attendance.restore(input.recordId);
            break;
          }
        }
        return [];
      },
    );
  }

  listOperations(): OperationEntry[] {
    return (
      this.store
        .prepare(
          "SELECT * FROM operation_history ORDER BY created_at DESC, rowid DESC LIMIT 100",
        )
        .all() as unknown as History[]
    ).map((row) => this.entry(row));
  }

  planOvertime(
    input: OvertimeInput & { operationId: string },
  ): OperationResult {
    const replay = this.replay(input.operationId, input);
    if (replay) return replay;
    const old = this.store
      .prepare(
        "SELECT s.id FROM shifts s JOIN schedule_imports si ON si.id=s.schedule_import_id WHERE si.source_sha256=? AND s.date=? AND s.start_time=? AND s.end_time=? AND s.work_type='overtime'",
      )
      .get(
        "system-overtime-" + input.date.slice(0, 7),
        input.date,
        input.startTime,
        input.endTime,
      );
    const shiftId = String(old?.id ?? randomUUID());
    return this.run(input.operationId, "安排加班", input, [shiftId], () => {
      this.adjustments.createOvertime(input, shiftId);
      return [];
    });
  }

  undo(id: string): OperationResult {
    return this.store.transaction(() => {
      const row = this.store
        .prepare("SELECT * FROM operation_history WHERE id=?")
        .get(id) as History | undefined;
      if (!row) throw new Error("操作不存在");
      const ids = JSON.parse(row.shift_ids_json) as string[];
      if (row.undone_at)
        return {
          operation: this.entry(row),
          affectedDates: [],
          dataRevision: this.store.dataRevision(),
          newRecordIds: [],
        };
      if (JSON.stringify(this.snapshot(ids)) !== row.after_json)
        throw new Error("后续数据已变化，不能直接撤销；请在记录详情中更正");
      const before = JSON.parse(row.before_json) as State;
      const after = JSON.parse(row.after_json) as State;
      // Deactivate new rows first to release partial unique indexes. Never delete audit objects.
      for (const record of after.attendance_records)
        if (!before.attendance_records.some((r) => r.id === record.id))
          this.attendance.revoke(String(record.id));
      for (const leave of after.leave_records)
        if (!before.leave_records.some((r) => r.id === leave.id))
          this.adjustments.cancelLeave(String(leave.id));
      for (const slot of after.shift_slots)
        if (!before.shift_slots.some((r) => r.id === slot.id))
          this.store
            .prepare("UPDATE shift_slots SET is_vacant=1 WHERE id=?")
            .run(slot.id!);
      for (const shift of after.shifts)
        if (!before.shifts.some((r) => r.id === shift.id)) {
          if (
            this.store
              .prepare(
                "SELECT id FROM attendance_records WHERE shift_id=? LIMIT 1",
              )
              .get(shift.id!)
          )
            throw new Error("已有签到历史，不能撤销新建班次");
          this.store
            .prepare("UPDATE shifts SET active=0,cancelled=1 WHERE id=?")
            .run(shift.id!);
        }
      for (const table of [
        "shifts",
        "shift_slots",
        "leave_records",
        "attendance_records",
      ] as const) {
        for (const target of before[table]) {
          const keys = Object.keys(target).filter(
            (key) => key !== "id" && key !== "revision",
          );
          if (table === "attendance_records") {
            const current = after.attendance_records.find(
              (r) => r.id === target.id,
            );
            if (current?.status !== target.status)
              this.attendance[
                target.status === "active" ? "restore" : "revoke"
              ](String(target.id));
            if (
              target.status === "active" &&
              current?.actual_member_id !== target.actual_member_id
            )
              this.attendance.correctMember(
                String(target.id),
                String(target.actual_member_id),
              );
          }
          this.store
            .prepare(
              `UPDATE ${table} SET ${keys.map((key) => `${key}=?`).join(",")} WHERE id=?`,
            )
            .run(...keys.map((key) => target[key]!), target.id!);
        }
      }
      for (const shiftId of ids) this.sync(shiftId);
      const undoneAt = new Date().toISOString();
      this.store
        .prepare("UPDATE operation_history SET undone_at=? WHERE id=?")
        .run(undoneAt, id);
      return {
        operation: this.entry({ ...row, undone_at: undoneAt }),
        affectedDates: [
          ...new Set(
            [...before.shifts, ...after.shifts].map((s) => String(s.date)),
          ),
        ],
        dataRevision: this.store.dataRevision(),
        newRecordIds: [],
      };
    });
  }

  private addSlot(shiftId: string, memberId: string, workType: string): void {
    const position = Number(
      this.store
        .prepare(
          "SELECT COALESCE(MAX(position),0)+1 AS n FROM shift_slots WHERE shift_id=?",
        )
        .get(shiftId)!.n,
    );
    this.store
      .prepare(
        "INSERT INTO shift_slots(id,shift_id,position,scheduled_member_id,slot_role,slot_source) VALUES(?,?,?,?,?,'manual')",
      )
      .run(
        randomUUID(),
        shiftId,
        position,
        memberId,
        workType === "overtime" ? "overtime" : "staff",
      );
  }
  private restoreSlot(slotId: string): void {
    const row = this.store
      .prepare(
        "SELECT ss.*, s.active FROM shift_slots ss JOIN shifts s ON s.id=ss.shift_id WHERE ss.id=?",
      )
      .get(slotId) as Row | undefined;
    if (
      !row ||
      row.slot_source !== "manual" ||
      row.slot_role !== "staff" ||
      !row.active
    )
      throw new Error("该临时席位不能恢复");
    if (!this.members.get(String(row.scheduled_member_id))?.active)
      throw new Error("原成员不存在或已停用");
    if (
      this.store
        .prepare(
          "SELECT ss.id FROM shift_slots ss LEFT JOIN leave_records lr ON lr.shift_slot_id=ss.id AND lr.status='active' WHERE ss.shift_id=? AND (ss.scheduled_member_id=? OR lr.replacement_member_id=?) AND ss.is_vacant=0 AND ss.id<>?",
        )
        .get(
          row.shift_id!,
          row.scheduled_member_id!,
          row.scheduled_member_id!,
          slotId,
        )
    )
      throw new Error("该成员已在本班次中");
    this.store
      .prepare("UPDATE shift_slots SET is_vacant=0 WHERE id=?")
      .run(slotId);
    this.sync(String(row.shift_id));
  }
  private sync(id: string): void {
    this.store
      .prepare(
        "UPDATE shifts SET required_slots=MAX(1,(SELECT COUNT(*) FROM shift_slots WHERE shift_id=? AND is_vacant=0)) WHERE id=?",
      )
      .run(id, id);
  }
  private expectRevision(id: string, expected?: number): void {
    const revision = Number(
      this.store.prepare("SELECT revision FROM shifts WHERE id=?").get(id)
        ?.revision,
    );
    if (!Number.isFinite(revision)) throw new Error("班次不存在");
    if (expected !== undefined && revision !== expected)
      throw new Error("班次已变化，请刷新后重试");
  }
  private snapshot(ids: string[]): State {
    const marks = ids.map(() => "?").join(",");
    return {
      shifts: this.store
        .prepare(`SELECT * FROM shifts WHERE id IN (${marks}) ORDER BY id`)
        .all(...ids) as Row[],
      shift_slots: this.store
        .prepare(
          `SELECT * FROM shift_slots WHERE shift_id IN (${marks}) ORDER BY id`,
        )
        .all(...ids) as Row[],
      attendance_records: this.store
        .prepare(
          `SELECT * FROM attendance_records WHERE shift_id IN (${marks}) ORDER BY id`,
        )
        .all(...ids) as Row[],
      leave_records: this.store
        .prepare(
          `SELECT * FROM leave_records WHERE shift_slot_id IN (SELECT id FROM shift_slots WHERE shift_id IN (${marks})) ORDER BY id`,
        )
        .all(...ids) as Row[],
    };
  }
  private entry(row: History): OperationEntry {
    return {
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      undoneAt: row.undone_at,
      canUndo:
        !row.undone_at &&
        JSON.stringify(this.snapshot(JSON.parse(row.shift_ids_json))) ===
          row.after_json,
    };
  }
  private replay(id: string, input: unknown): OperationResult | null {
    const row = this.store
      .prepare("SELECT * FROM operation_history WHERE id=?")
      .get(id) as History | undefined;
    if (!row) return null;
    if (row.request_json !== JSON.stringify(input))
      throw new Error("操作标识已被不同命令使用");
    return {
      ...JSON.parse(row.result_json),
      operation: this.entry(row),
      occurrences: (JSON.parse(row.shift_ids_json) as string[]).map((shiftId) =>
        this.get(shiftId),
      ),
    };
  }
  private run(
    id: string,
    label: string,
    input: unknown,
    ids: string[],
    action: () => string[],
  ): OperationResult {
    const replay = this.replay(id, input);
    if (replay) return replay;
    return this.store.transaction(() => {
      this.store.captureSources();
      const before = this.snapshot(ids);
      const newRecordIds = action();
      const after = this.snapshot(ids);
      const row: History = {
        id,
        label,
        request_json: JSON.stringify(input),
        shift_ids_json: JSON.stringify(ids),
        before_json: JSON.stringify(before),
        after_json: JSON.stringify(after),
        result_json: "",
        created_at: new Date().toISOString(),
        undone_at: null,
      };
      const result: OperationResult = {
        operation: this.entry(row),
        affectedDates: [
          ...new Set(
            [...before.shifts, ...after.shifts].map((s) => String(s.date)),
          ),
        ],
        dataRevision: this.store.dataRevision(),
        newRecordIds,
      };
      this.store
        .prepare(
          "INSERT INTO operation_history(id,label,request_json,shift_ids_json,before_json,after_json,result_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          label,
          row.request_json,
          row.shift_ids_json,
          row.before_json,
          row.after_json,
          JSON.stringify(result),
          row.created_at,
        );
      return {
        ...result,
        occurrences: ids.map((shiftId) => this.get(shiftId)),
      };
    });
  }
}
