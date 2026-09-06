import { describe, expect, it } from "vitest";
import { defaultReportDraft, reportFileNames, sanitizeFilePart, scoreTotal, suggestedAttendanceScore } from "./report";

describe("月报领域规则", () => {
  it("默认周期为上月 26 日到本月 25 日", () => {
    const draft = defaultReportDraft(2026, 9);
    expect(draft.startDate).toBe("2026-08-26");
    expect(draft.endDate).toBe("2026-09-25");
  });

  it("文件名使用填表人和填写日期", () => {
    const draft = { ...defaultReportDraft(2026, 9), filler: "张三", fillDate: "2026-09-25" };
    const names = reportFileNames(draft);
    expect(names.workReport).toBe("9月工作报表-网络中心-张三.docx");
    expect(names.performance).toBe("9月绩效考核表网络中心张三20260925.docx");
  });

  it("总分封顶 100，活动附加默认不等于 5", () => {
    expect(scoreTotal({ attendance: 30, hours: 10, self: 10, peer: 20, supervisor: 30, activity: 5 })).toBe(100);
    expect(scoreTotal({ attendance: 30, hours: 10, self: 10, peer: 20, supervisor: 30, activity: 0 })).toBe(100);
  });

  it("迟到建议分不影响工时且不低于零", () => {
    expect(suggestedAttendanceScore(2, 1)).toBe(28);
    expect(suggestedAttendanceScore(40, 1)).toBe(0);
  });

  it("清理 Windows 非法文件名字符", () => {
    expect(sanitizeFilePart('张:三/四')).toBe("张_三_四");
  });
});

