import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseStore } from "../database";
import { MemberService } from "./member-service";
import { ScheduleService } from "./schedule-service";
import { createThreeBlockSchedule } from "./schedule-fixture.test-util";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("ScheduleService", () => {
  it("保存源文件、建立班次席位，并对相同文件保持幂等", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkin-import-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "排班.xlsx");
    await createThreeBlockSchedule(source);
    const store = new DatabaseStore(":memory:");
    try {
      const members = new MemberService(store);
      const service = new ScheduleService(store, members, join(directory, "sources"));
      const first = await service.import(source, "2026-08", "2026-08-01", { attendanceMode: "lenient", lateThresholdMinutes: 15, latePenaltyPoints: 1 });
      const second = await service.import(source, "2026-08", "2026-08-01", { attendanceMode: "late_mark", lateThresholdMinutes: 5, latePenaltyPoints: 2 });
      expect(first.duplicate).toBe(false);
      expect(first.shiftCount).toBe(89);
      expect(first.slotCount).toBeGreaterThan(first.shiftCount);
      expect(first.createdMembers).toContain("李佳欣");
      expect(second.duplicate).toBe(true);
      expect(second.importId).toBe(first.importId);
      expect((store.prepare("SELECT COUNT(*) AS count FROM schedule_imports").get() as { count: number }).count).toBe(1);

      store.prepare("DELETE FROM shifts WHERE kind = 'weekend'").run();
      const repaired = await service.import(source, "2026-08", "2026-08-01", { attendanceMode: "lenient", lateThresholdMinutes: 15, latePenaltyPoints: 1 });
      expect(repaired.duplicate).toBe(false);
      expect((store.prepare("SELECT COUNT(*) AS count FROM shifts WHERE kind = 'weekend'").get() as { count: number }).count).toBeGreaterThan(0);
      expect((await service.import(source, "2026-08", "2026-08-01", { attendanceMode: "lenient", lateThresholdMinutes: 15, latePenaltyPoints: 1 })).duplicate).toBe(true);
    } finally {
      store.close();
    }
  });
});
