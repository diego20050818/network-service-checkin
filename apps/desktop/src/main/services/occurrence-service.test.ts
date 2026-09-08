import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseStore } from "../database";
import { MemberService } from "./member-service";
import { AttendanceService } from "./attendance-service";
import { AdjustmentService } from "./adjustment-service";
import { OccurrenceService } from "./occurrence-service";
import { addScheduleImport, addShift } from "./test-helpers.test-util";

const stores: DatabaseStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function fixture() {
  const store = new DatabaseStore(":memory:");
  stores.push(store);
  const members = new MemberService(store);
  const attendance = new AttendanceService(store, members);
  const adjustments = new AdjustmentService(store, members, attendance);
  const service = new OccurrenceService(
    store,
    attendance,
    adjustments,
    members,
  );
  const shift = addShift(store, members, {
    importId: addScheduleImport(store),
    date: "2099-09-08",
    kind: "desk",
    startTime: "08:00",
    endTime: "10:00",
    paidMinutes: 120,
    people: ["甲"],
  });
  return { store, members, attendance, service, shift };
}
describe("single occurrences and durable undo", () => {
  it("moves only an occurrence, keeps IDs and source, rejects stale edits", () => {
    const { service, shift, store } = fixture();
    const before = service.get(shift.shiftId);
    const input = {
      id: before.id,
      operationId: randomUUID(),
      expectedRevision: before.revision,
      date: before.date,
      kind: before.kind,
      workType: before.workType,
      startTime: "09:07",
      endTime: "11:07",
      label: before.label,
      note: "",
      memberIds: [shift.memberIds.甲!],
    };
    const changed = service.save(input);
    expect(service.get(before.id).startTime).toBe("09:07");
    expect(service.get(before.id).slots[0]!.id).toBe(shift.slotIds[0]);
    expect(
      store
        .prepare("SELECT payload_json FROM shift_sources WHERE shift_id = ?")
        .get(before.id),
    ).toBeTruthy();
    expect(() => service.save({ ...input, operationId: randomUUID() })).toThrow(
      /已变化/,
    );
    expect(service.save(input).operation.id).toBe(changed.operation.id);
    service.undo(changed.operation.id);
    expect(service.get(before.id).startTime).toBe("08:00");
  });
  it("removes and restores the same staff slot, including a compound attendance undo", () => {
    const { service, shift, members, attendance } = fixture();
    const b = members.save({ name: "乙" });
    service.action({
      type: "addStaff",
      shiftId: shift.shiftId,
      memberId: b.id,
      operationId: randomUUID(),
    });
    const slot = service
      .get(shift.shiftId)
      .slots.find((s) => s.scheduledMemberId === b.id)!;
    const record = attendance.addManual({ slotId: slot.id, memberId: b.id });
    const op = service.action({
      type: "revokeAndRemove",
      shiftId: shift.shiftId,
      slotId: slot.id,
      recordId: record.id,
      operationId: randomUUID(),
    });
    expect(attendance.getRecord(record.id).status).toBe("revoked");
    expect(service.get(shift.shiftId).slots.some((s) => s.id === slot.id)).toBe(
      false,
    );
    service.undo(op.operation.id);
    expect(service.get(shift.shiftId).slots.some((s) => s.id === slot.id)).toBe(
      true,
    );
    expect(attendance.getRecord(record.id).status).toBe("active");
  });
  it("locks historical time, including revoked records, and conflicts undo after later writes", () => {
    const { service, shift, attendance } = fixture();
    const record = attendance.addManual({
      slotId: shift.slotIds[0]!,
      memberId: shift.memberIds.甲!,
    });
    const op = service.action({
      type: "revoke",
      shiftId: shift.shiftId,
      recordId: record.id,
      operationId: randomUUID(),
    });
    expect(service.get(shift.shiftId).editable).toBe(false);
    attendance.restore(record.id);
    expect(() => service.undo(op.operation.id)).toThrow(/已变化/);
    expect(attendance.getRecord(record.id).paidMinutes).toBe(120);
  });
  it("rolls back the whole compound command when removal fails", () => {
    const { service, shift, attendance } = fixture();
    const record = attendance.addManual({
      slotId: shift.slotIds[0]!,
      memberId: shift.memberIds.甲!,
    });
    expect(() =>
      service.action({
        type: "revokeAndRemove",
        shiftId: shift.shiftId,
        slotId: shift.slotIds[0]!,
        recordId: record.id,
        operationId: randomUUID(),
      }),
    ).toThrow();
    expect(attendance.getRecord(record.id).status).toBe("active");
  });
  it("journals leave creation, undo and recovery using the original leave ID", () => {
    const { service, shift, store } = fixture();
    const created = service.action({
      type: "createLeave",
      shiftId: shift.shiftId,
      slotId: shift.slotIds[0]!,
      reason: "临时请假",
      operationId: randomUUID(),
    });
    const leave = store.prepare("SELECT id FROM leave_records").get()!;
    service.undo(created.operation.id);
    expect(
      store
        .prepare("SELECT status FROM leave_records WHERE id=?")
        .get(leave.id!)!.status,
    ).toBe("cancelled");
    const restored = service.action({
      type: "restoreLeave",
      shiftId: shift.shiftId,
      leaveId: String(leave.id),
      operationId: randomUUID(),
    });
    expect(service.get(shift.shiftId).slots[0]!.leave?.id).toBe(leave.id);
    service.undo(restored.operation.id);
    expect(service.get(shift.shiftId).slots[0]!.leave).toBeNull();
  });
  it("recovers overtime and its historical attendance on the original IDs", () => {
    const { service, shift, attendance, store } = fixture();
    const input = {
      date: "2099-09-09",
      startTime: "09:07",
      endTime: "10:22",
      memberId: shift.memberIds.甲!,
      operationId: randomUUID(),
    };
    const planned = service.planOvertime(input);
    const occurrence = planned.occurrences![0]!;
    const slotId = occurrence.slots[0]!.id;
    expect(service.planOvertime(input).occurrences![0]!.id).toBe(occurrence.id);
    const record = attendance.addManual({ slotId, memberId: input.memberId });
    service.action({
      type: "revoke",
      shiftId: occurrence.id,
      recordId: record.id,
      operationId: randomUUID(),
    });
    service.action({
      type: "cancelOvertime",
      shiftId: occurrence.id,
      slotId,
      operationId: randomUUID(),
    });
    service.action({
      type: "restore",
      shiftId: occurrence.id,
      recordId: record.id,
      operationId: randomUUID(),
    });
    expect(attendance.getRecord(record.id)).toMatchObject({
      status: "active",
      slotId,
      paidMinutes: 75,
    });
    expect(
      store.prepare("SELECT COUNT(*) AS n FROM attendance_records").get()!.n,
    ).toBe(1);
  });
  it("undoes overtime creation without removing a previously planned colleague", () => {
    const { service, shift, members } = fixture();
    const input = {
      date: "2099-09-09",
      startTime: "11:00",
      endTime: "12:00",
      memberId: shift.memberIds.甲!,
    };
    const first = service.planOvertime({ ...input, operationId: randomUUID() });
    const second = service.planOvertime({
      ...input,
      memberId: members.save({ name: "乙" }).id,
      operationId: randomUUID(),
    });
    service.undo(second.operation.id);
    expect(
      service
        .get(first.occurrences![0]!.id)
        .slots.map((s) => s.scheduledMemberId),
    ).toEqual([input.memberId]);
  });
});
