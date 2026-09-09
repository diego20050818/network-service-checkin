import { describe, expect, it } from "vitest";
import type { ShiftView } from "../shared/contracts";
import { layoutOverlappingShifts, mondayOfWeek, weeklySlotState } from "./weekly-calendar";
import {
  ATTENDANCE_STATE_MARK,
  attendanceShiftVisualState,
  selectAttendanceAgendaTarget,
} from "./attendance-visual";

function shift(id: string, startTime: string, endTime: string): ShiftView {
  return {
    id,
    date: "2026-09-07",
    kind: "desk",
    label: "坐班",
    workType: "regular",
    note: "",
    startTime,
    endTime,
    paidMinutes: 120,
    attendanceMode: "lenient",
    lateThresholdMinutes: 15,
    slots: [{
      id: `${id}-slot`, position: 1, scheduledMemberId: "member-1", scheduledMemberName: "甲",
      attendanceId: null, actualMemberId: null, actualMemberName: null, punchTime: null, lateStatus: null,
      role: "responsible", source: "imported", note: "", leave: null,
    }],
  };
}

describe("weekly calendar", () => {
  it("以周一作为周起点", () => {
    expect(mondayOfWeek(new Date(2026, 8, 7, 12))).toBe("2026-09-07");
    expect(mondayOfWeek(new Date(2026, 8, 13, 12))).toBe("2026-09-07");
  });

  it("到岗为绿色状态、已到班未签到为红色、未到班为灰色", () => {
    const item = shift("one", "08:00", "10:00");
    const slot = item.slots[0]!;
    expect(weeklySlotState(item, slot, new Date(2026, 8, 7, 7, 59))).toBe("upcoming");
    expect(weeklySlotState(item, slot, new Date(2026, 8, 7, 8, 0))).toBe("absent");
    expect(weeklySlotState(item, { ...slot, attendanceId: "record-1" }, new Date(2026, 8, 7, 7, 0))).toBe("arrived");
  });

  it("班次颜色按全部处理、待签到、未开始和请假统一计算", () => {
    const item = shift("states", "08:00", "10:00");
    const first = item.slots[0]!;
    const second = {
      ...first,
      id: "states-slot-2",
      scheduledMemberId: "member-2",
      scheduledMemberName: "乙",
    };
    item.slots = [first, second];
    expect(attendanceShiftVisualState(item, new Date(2026, 8, 7, 7, 59))).toBe(
      "upcoming",
    );
    expect(attendanceShiftVisualState(item, new Date(2026, 8, 7, 8, 0))).toBe(
      "attention",
    );
    item.slots = [
      { ...first, attendanceId: "record-1" },
      {
        ...second,
        leave: {
          id: "leave-1",
          memberId: "member-2",
          memberName: "乙",
          replacementMemberId: null,
          replacementMemberName: null,
          reason: "测试",
          status: "active",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      },
    ];
    expect(attendanceShiftVisualState(item, new Date(2026, 8, 7, 8, 0))).toBe(
      "complete",
    );
    item.slots = [item.slots[1]!];
    expect(attendanceShiftVisualState(item, new Date(2026, 8, 7, 8, 0))).toBe(
      "leave",
    );
    expect(ATTENDANCE_STATE_MARK).toEqual({
      arrived: "✓",
      absent: "×",
      upcoming: "○",
      leave: "—",
    });
  });

  it("首次定位优先最早当前班，没有当前班时选择最近下一班", () => {
    const ended = shift("ended", "07:00", "08:00");
    const current = shift("current", "09:00", "11:00");
    const next = shift("next", "11:00", "12:00");
    expect(
      selectAttendanceAgendaTarget(
        [next, ended, current],
        new Date(2026, 8, 7, 10, 0),
      )?.id,
    ).toBe("current");
    expect(
      selectAttendanceAgendaTarget(
        [next, ended],
        new Date(2026, 8, 7, 10, 0),
      )?.id,
    ).toBe("next");
    expect(
      selectAttendanceAgendaTarget(
        [ended],
        new Date(2026, 8, 7, 10, 0),
      )?.id,
    ).toBe("ended");
  });

  it("重叠班次分配到不同显示轨道", () => {
    const positioned = layoutOverlappingShifts([
      shift("desk", "16:15", "17:30"),
      shift("maintenance", "17:00", "19:00"),
      shift("later", "19:00", "20:00"),
    ]);
    expect(positioned.find((item) => item.shift.id === "desk")?.lane).not.toBe(positioned.find((item) => item.shift.id === "maintenance")?.lane);
    expect(positioned.find((item) => item.shift.id === "later")?.lane).toBe(0);
  });
});
