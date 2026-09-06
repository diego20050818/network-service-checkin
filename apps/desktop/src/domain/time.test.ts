import { describe, expect, it } from "vitest";
import { isWithinShift, lateStatusFor, paidMinutesBetween } from "./time";

describe("班次计时规则", () => {
  it("使用开始闭合结束开放的签到窗口", () => {
    expect(isWithinShift("08:00", "08:00", "10:00")).toBe(true);
    expect(isWithinShift("09:59", "08:00", "10:00")).toBe(true);
    expect(isWithinShift("10:00", "08:00", "10:00")).toBe(false);
  });

  it("按完整班次分钟计薪", () => {
    expect(paidMinutesBetween("16:15", "17:30")).toBe(75);
    expect(paidMinutesBetween("17:00", "19:00")).toBe(120);
    expect(75 + 120).toBe(195);
  });

  it("阈值时刻正常，严格晚于阈值才迟到", () => {
    expect(lateStatusFor("08:15", "08:00", "late_mark", 15, "realtime")).toBe("normal");
    expect(lateStatusFor("08:16", "08:00", "late_mark", 15, "realtime")).toBe("late");
    expect(lateStatusFor("09:59", "08:00", "lenient", 15, "realtime")).toBe("normal");
  });

  it("没有历史时刻的人工补记保持未判定", () => {
    expect(lateStatusFor(null, "08:00", "late_mark", 15, "manual")).toBe("manual_unjudged");
  });

  it("拒绝跨午夜班次", () => {
    expect(() => paidMinutesBetween("23:00", "01:00")).toThrow("跨午夜");
  });
});

