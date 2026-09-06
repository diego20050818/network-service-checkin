import { describe, expect, it } from "vitest";
import type { ShiftView } from "../shared/contracts";
import { layoutOverlappingShifts, mondayOfWeek, weeklySlotState } from "./weekly-calendar";

function shift(id: string, startTime: string, endTime: string): ShiftView {
  return {
    id,
    date: "2026-09-07",
    kind: "desk",
    label: "坐班",
    startTime,
    endTime,
    paidMinutes: 120,
    attendanceMode: "lenient",
    lateThresholdMinutes: 15,
    slots: [{
      id: `${id}-slot`, position: 1, scheduledMemberId: "member-1", scheduledMemberName: "甲",
      attendanceId: null, actualMemberId: null, actualMemberName: null, punchTime: null, lateStatus: null,
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
