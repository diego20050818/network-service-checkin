import { describe, expect, it, vi } from "vitest";
import { DraftStore } from "./draft-store";
import { defaultReportDraft } from "../../domain/report";
import type { ReportDraft } from "../../shared/contracts";

describe("draft sessions", () => {
  it("flushes the last keystroke before 650ms and serializes edits arriving during a save", async () => {
    const writes: ReportDraft[] = [];
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = {
      getReportDraft: async (y: number, m: number) => ({
        ...defaultReportDraft(y, m),
        revision: 0,
      }),
      saveReportDraft: vi.fn(async (draft: ReportDraft) => {
        writes.push(draft);
        if (writes.length === 1) await wait;
        return { ...draft, revision: writes.length };
      }),
    };
    const store = new DraftStore(api);
    const s = await store.open(2026, 9);
    s.edit({ ...s.snapshot().draft!, advice: "first" });
    const flushing = store.flushAll();
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    s.edit({ ...s.snapshot().draft!, advice: "last" });
    release();
    await flushing;
    expect(writes.map((d) => d.advice)).toEqual(["first", "last"]);
    expect(writes[1]!.revision).toBe(1);
    expect(s.snapshot().status).toBe("saved");
    store.dispose();
  });
  it("retains input on failure and keeps month sessions separate", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementation(async (d: ReportDraft) => ({ ...d, revision: 1 }));
    const store = new DraftStore({
      getReportDraft: async (y, m) => defaultReportDraft(y, m),
      saveReportDraft: save,
    });
    const a = await store.open(2026, 9);
    a.edit({ ...a.snapshot().draft!, advice: "keep me" });
    await expect(store.flushAll()).rejects.toThrow("disk full");
    expect(a.snapshot().draft!.advice).toBe("keep me");
    const b = await store.open(2026, 10);
    expect(b.snapshot().draft!.advice).not.toBe("keep me");
    await store.flushAll();
    expect(a.snapshot().status).toBe("saved");
    store.dispose();
  });
});
