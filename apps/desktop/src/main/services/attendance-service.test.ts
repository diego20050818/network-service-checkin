import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseStore } from "../database";
import { AttendanceService } from "./attendance-service";
import { MemberService } from "./member-service";
import { addScheduleImport, addShift } from "./test-helpers.test-util";

describe("AttendanceService", () => {
  let store: DatabaseStore;
  let members: MemberService;
  let attendance: AttendanceService;
  let importId: string;

  beforeEach(() => {
    store = new DatabaseStore(":memory:");
    members = new MemberService(store);
    attendance = new AttendanceService(store, members);
    importId = addScheduleImport(store);
  });
  afterEach(() => store.close());

  it("09:59 签到计完整两小时，重复提交保持一条记录", () => {
    const shift = addShift(store, members, { importId, date: "2026-09-07", kind: "desk", startTime: "08:00", endTime: "10:00", paidMinutes: 120, people: ["甲"] });
    const selection = [{ slotId: shift.slotIds[0]!, memberId: shift.memberIds.甲! }];
    const first = attendance.checkIn(shift.shiftId, selection, "2026-09-07T09:59:00+08:00");
    const second = attendance.checkIn(shift.shiftId, selection, "2026-09-07T09:59:30+08:00");
    expect(first[0]?.record.paidMinutes).toBe(120);
    expect(first[0]?.alreadyExisted).toBe(false);
    expect(second[0]?.alreadyExisted).toBe(true);
    expect(attendance.listRecords()).toHaveLength(1);
    expect(() => attendance.checkIn(shift.shiftId, selection, "2026-09-07T10:00:00+08:00")).toThrow("不在");
  });

  it("同一人在重叠的两个独立班分别签到并累计 3.25 小时", () => {
    const desk = addShift(store, members, { importId, date: "2026-09-07", kind: "desk", startTime: "16:15", endTime: "17:30", paidMinutes: 75, people: ["甲"] });
    const maintenance = addShift(store, members, { importId, date: "2026-09-07", kind: "maintenance", startTime: "17:00", endTime: "19:00", paidMinutes: 120, people: ["甲", "乙", "丙"] });
    attendance.checkIn(desk.shiftId, [{ slotId: desk.slotIds[0]!, memberId: desk.memberIds.甲! }], "2026-09-07T17:10:00+08:00");
    attendance.checkIn(maintenance.shiftId, [{ slotId: maintenance.slotIds[0]!, memberId: desk.memberIds.甲! }], "2026-09-07T17:10:00+08:00");
    expect(attendance.listRecords().reduce((sum, record) => sum + record.paidMinutes, 0)).toBe(195);
  });

  it("多人批次拒绝同一成员占两个席位且不产生部分写入", () => {
    const shift = addShift(store, members, { importId, date: "2026-09-07", kind: "maintenance", startTime: "17:00", endTime: "19:00", paidMinutes: 120, people: ["甲", "乙", "丙"] });
    expect(() => attendance.checkIn(shift.shiftId, [
      { slotId: shift.slotIds[0]!, memberId: shift.memberIds.甲! },
      { slotId: shift.slotIds[1]!, memberId: shift.memberIds.甲! },
    ], "2026-09-07T17:30:00+08:00")).toThrow("不能占用多个席位");
    expect(attendance.listRecords()).toHaveLength(0);
  });

  it("更正人员只转移同一记录，撤销后可恢复", () => {
    const shift = addShift(store, members, { importId, date: "2026-09-07", kind: "desk", startTime: "08:00", endTime: "10:00", paidMinutes: 120, people: ["甲"] });
    const 乙 = members.ensureMinimal("乙").member;
    const record = attendance.checkIn(shift.shiftId, [{ slotId: shift.slotIds[0]!, memberId: shift.memberIds.甲! }], "2026-09-07T09:00:00+08:00")[0]!.record;
    expect(attendance.correctMember(record.id, 乙.id).actualMemberName).toBe("乙");
    expect(attendance.listRecords()).toHaveLength(1);
    attendance.revoke(record.id);
    expect(attendance.listRecords()).toHaveLength(0);
    expect(attendance.restore(record.id).status).toBe("active");
  });

  it("没有历史时刻的人工补记保留未判定迟到", () => {
    const shift = addShift(store, members, { importId, date: "2026-09-07", kind: "desk", startTime: "08:00", endTime: "10:00", paidMinutes: 120, people: ["甲"], mode: "late_mark" });
    const record = attendance.addManual({ slotId: shift.slotIds[0]!, memberId: shift.memberIds.甲!, historicalPunchTime: null });
    expect(record.source).toBe("manual");
    expect(record.punchTime).toBeNull();
    expect(record.lateStatus).toBe("manual_unjudged");
    expect(record.paidMinutes).toBe(120);
  });
});

