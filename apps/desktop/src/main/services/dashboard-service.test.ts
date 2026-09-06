import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseStore } from "../database";
import { AttendanceService } from "./attendance-service";
import { DashboardService } from "./dashboard-service";
import { MemberService } from "./member-service";
import { addScheduleImport, addShift } from "./test-helpers.test-util";

describe("DashboardService", () => {
  let store: DatabaseStore;
  let members: MemberService;
  let attendance: AttendanceService;
  let dashboard: DashboardService;
  let importId: string;

  beforeEach(() => {
    store = new DatabaseStore(":memory:");
    members = new MemberService(store);
    attendance = new AttendanceService(store, members);
    dashboard = new DashboardService(store, attendance, members);
    importId = addScheduleImport(store);
  });
  afterEach(() => store.close());

  it("空位不进入到岗率分母和未到岗计数", () => {
    const desk = addShift(store, members, { importId, date: "2026-09-07", kind: "desk", startTime: "08:00", endTime: "10:00", paidMinutes: 120, people: ["甲"] });
    const maintenance = addShift(store, members, { importId, date: "2026-09-07", kind: "maintenance", startTime: "17:00", endTime: "19:00", paidMinutes: 120, people: ["甲", "乙", null] });
    attendance.checkIn(desk.shiftId, [{ slotId: desk.slotIds[0]!, memberId: desk.memberIds.甲! }], "2026-09-07T09:00:00+08:00");
    attendance.checkIn(maintenance.shiftId, [
      { slotId: maintenance.slotIds[0]!, memberId: maintenance.memberIds.甲! },
    ], "2026-09-07T18:00:00+08:00");
    const snapshot = dashboard.snapshot({ startDate: "2026-09-01", endDate: "2026-09-30", now: "2026-09-07T20:00:00+08:00" });
    expect(snapshot.metrics.attendedEndedSlots).toBe(2);
    expect(snapshot.metrics.endedSlots).toBe(3);
    expect(snapshot.metrics.attendanceRate).toBeCloseTo(2 / 3);
    expect(snapshot.metrics.missingEndedSlots).toBe(1);
    expect(snapshot.metrics.paidMinutes).toBe(240);
    expect(attendance.getShift(maintenance.shiftId)?.slots).toHaveLength(2);
  });

  it("未来班次不进入到岗率分母", () => {
    addShift(store, members, { importId, date: "2026-09-08", kind: "desk", startTime: "08:00", endTime: "10:00", paidMinutes: 120, people: ["甲"] });
    const snapshot = dashboard.snapshot({ startDate: "2026-09-01", endDate: "2026-09-30", now: "2026-09-07T20:00:00+08:00" });
    expect(snapshot.metrics.endedSlots).toBe(0);
    expect(snapshot.metrics.attendanceRate).toBeNull();
  });

  it("成员筛选不改变顶部团队指标", () => {
    const shift = addShift(store, members, { importId, date: "2026-09-07", kind: "maintenance", startTime: "17:00", endTime: "19:00", paidMinutes: 120, people: ["甲", "乙", "丙"] });
    attendance.checkIn(shift.shiftId, [
      { slotId: shift.slotIds[0]!, memberId: shift.memberIds.甲! },
      { slotId: shift.slotIds[1]!, memberId: shift.memberIds.乙! },
    ], "2026-09-07T18:00:00+08:00");
    const all = dashboard.snapshot({ startDate: "2026-09-01", endDate: "2026-09-30", now: "2026-09-07T20:00:00+08:00" });
    const one = dashboard.snapshot({ startDate: "2026-09-01", endDate: "2026-09-30", now: "2026-09-07T20:00:00+08:00", memberId: shift.memberIds.甲 });
    expect(one.metrics).toEqual(all.metrics);
    expect(one.members).toHaveLength(1);
    expect(one.records).toHaveLength(1);
  });
});
