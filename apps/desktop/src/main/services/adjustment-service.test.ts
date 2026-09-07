import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseStore } from "../database";
import { AdjustmentService } from "./adjustment-service";
import { AttendanceService } from "./attendance-service";
import { DashboardService } from "./dashboard-service";
import { MemberService } from "./member-service";
import { addScheduleImport, addShift } from "./test-helpers.test-util";

describe("AdjustmentService", () => {
  let store: DatabaseStore;
  let members: MemberService;
  let attendance: AttendanceService;
  let adjustments: AdjustmentService;
  let dashboard: DashboardService;

  beforeEach(() => {
    store = new DatabaseStore(":memory:");
    members = new MemberService(store);
    attendance = new AttendanceService(store, members);
    adjustments = new AdjustmentService(store, members, attendance);
    dashboard = new DashboardService(store, attendance, members);
  });
  afterEach(() => store.close());

  it("无代班请假豁免缺勤，有代班签到后锁定请假", () => {
    const importId = addScheduleImport(store);
    const past = addShift(store, members, { importId, date: "2026-09-06", kind: "desk", startTime: "08:00", endTime: "10:00", paidMinutes: 120, people: ["甲"] });
    const leave = adjustments.createLeave({ slotId: past.slotIds[0]!, reason: "病假" }, new Date("2026-09-06T11:00:00+08:00"));
    expect(leave.replacementMemberId).toBeNull();
    const snapshot = dashboard.snapshot({ startDate: "2026-09-06", endDate: "2026-09-06", now: "2026-09-06T11:00:00+08:00" });
    expect(snapshot.metrics).toMatchObject({ endedSlots: 0, missingEndedSlots: 0, leaveCount: 1, paidMinutes: 0 });
    expect(() => attendance.addManual({ slotId: past.slotIds[0]!, memberId: past.memberIds.甲! })).toThrow("没有代班人");

    const future = addShift(store, members, { importId, date: "2026-09-07", kind: "desk", startTime: "08:00", endTime: "10:00", paidMinutes: 120, people: ["甲"] });
    const replacement = members.ensureMinimal("乙").member;
    const futureLeave = adjustments.createLeave({ slotId: future.slotIds[0]!, replacementMemberId: replacement.id }, new Date("2026-09-07T07:00:00+08:00"));
    attendance.checkIn(future.shiftId, [{ slotId: future.slotIds[0]!, memberId: replacement.id }], "2026-09-07T08:00:00+08:00");
    expect(() => adjustments.cancelLeave(futureLeave.id)).toThrow("请先撤销签到");
  });

  it("加班创建不计薪，签到后按完整计划时长计入成员明细", () => {
    const member = members.ensureMinimal("甲").member;
    const first = adjustments.createOvertime({ memberId: member.id, date: "2026-09-07", startTime: "18:00", endTime: "20:00", note: "机房维护" });
    expect(dashboard.snapshot({ startDate: "2026-09-07", endDate: "2026-09-07", now: "2026-09-07T21:00:00+08:00" }).metrics.paidMinutes).toBe(0);
    expect(() => attendance.checkIn(first.shiftId, [{ slotId: first.slotId, memberId: member.id }], "2026-09-07T20:00:00+08:00")).toThrow("不在该班次");
    attendance.checkIn(first.shiftId, [{ slotId: first.slotId, memberId: member.id }], "2026-09-07T18:00:00+08:00");
    const snapshot = dashboard.snapshot({ startDate: "2026-09-07", endDate: "2026-09-07", kind: "all", now: "2026-09-07T21:00:00+08:00" });
    expect(snapshot.metrics).toMatchObject({ paidMinutes: 120, overtimeMinutes: 120, endedSlots: 0, lateCount: 0 });
    expect(snapshot.records[0]).toMatchObject({ workType: "overtime", slotRole: "overtime", paidMinutes: 120 });
    expect(snapshot.members.find((item) => item.memberId === member.id)).toMatchObject({ regularMinutes: 0, overtimeMinutes: 120, totalMinutes: 120 });
    expect(() => adjustments.cancelOvertime(first.slotId)).toThrow("请先撤销签到");
  });

  it("加班可预约未来日期：签到前不计薪，签到后计入", () => {
    const member = members.ensureMinimal("甲").member;
    const booked = adjustments.createOvertime({ memberId: member.id, date: "2026-09-20", startTime: "18:00", endTime: "20:00", note: "提前预约" });
    expect(booked.status).toBe("planned");

    // 预约当日（现在 9/8）：不计薪、无签到记录
    const before = dashboard.snapshot({ startDate: "2026-09-01", endDate: "2026-09-30", now: "2026-09-08T12:00:00+08:00" });
    expect(before.metrics.overtimeMinutes).toBe(0);
    expect(before.records).toHaveLength(0);
    expect(before.members.find((item) => item.memberId === member.id)?.totalMinutes).toBe(0);

    // 未来日期已过、仍未签到：不计薪、待补记
    const after = dashboard.snapshot({ startDate: "2026-09-20", endDate: "2026-09-20", now: "2026-09-21T09:00:00+08:00" });
    expect(after.metrics.overtimeMinutes).toBe(0);
    expect(after.records).toHaveLength(0);

    // 到那天签到后计薪
    attendance.checkIn(booked.shiftId, [{ slotId: booked.slotId, memberId: member.id }], "2026-09-20T18:00:00+08:00");
    const done = dashboard.snapshot({ startDate: "2026-09-20", endDate: "2026-09-20", now: "2026-09-20T21:00:00+08:00" });
    expect(done.metrics).toMatchObject({ paidMinutes: 120, overtimeMinutes: 120 });
    expect(done.records[0]).toMatchObject({ workType: "overtime", slotRole: "overtime", paidMinutes: 120 });
    expect(done.members.find((item) => item.memberId === member.id)).toMatchObject({ overtimeMinutes: 120, totalMinutes: 120 });
    expect(() => adjustments.cancelOvertime(booked.slotId)).toThrow("请先撤销签到");
  });

  it("办公人员只加入单次班次且无记录时可移除", () => {
    const importId = addScheduleImport(store);
    const shift = addShift(store, members, { importId, date: "2026-09-07", kind: "desk", startTime: "08:00", endTime: "10:00", paidMinutes: 120, people: ["甲"] });
    const staff = members.ensureMinimal("乙").member;
    const changed = adjustments.addShiftStaff({ shiftId: shift.shiftId, memberId: staff.id });
    const slot = changed.slots.find((item) => item.scheduledMemberId === staff.id)!;
    expect(slot).toMatchObject({ role: "staff", source: "manual" });
    expect(changed.slots).toHaveLength(2);
    expect(() => adjustments.addShiftStaff({ shiftId: shift.shiftId, memberId: staff.id })).toThrow("已在本班次");
    adjustments.removeShiftStaff(slot.id);
    expect(attendance.getShift(shift.shiftId)?.slots).toHaveLength(1);
  });
});
