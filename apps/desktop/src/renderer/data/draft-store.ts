import type { CheckinApi, ReportDraft } from "../../shared/contracts";
type Api = Pick<CheckinApi, "getReportDraft" | "saveReportDraft">;
export interface DraftState {
  draft: ReportDraft | null;
  status: "loading" | "unsaved" | "saving" | "saved" | "error";
  error: string;
  version: number;
}
export class DraftSession {
  private state: DraftState = {
    draft: null,
    status: "loading",
    error: "",
    version: 0,
  };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  private savedVersion = 0;
  private savedDraft: ReportDraft | null = null;
  readonly ready: Promise<void>;
  constructor(
    private api: Api,
    year: number,
    month: number,
  ) {
    this.ready = api
      .getReportDraft(year, month)
      .then((draft) => {
        this.savedDraft = draft;
        this.set({ draft, status: "saved" });
      })
      .catch((e) => {
        this.set({ status: "error", error: String(e) });
        throw e;
      });
  }
  snapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private set(patch: Partial<DraftState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  edit(draft: ReportDraft) {
    this.set({
      draft: { ...draft, revision: this.state.draft?.revision ?? 0 },
      version: this.state.version + 1,
      status: "unsaved",
      error: "",
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(() => undefined);
    }, 650);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    await this.ready;
    if (this.saving) {
      await this.saving;
      if (this.savedVersion !== this.state.version) return this.flush();
      return;
    }
    this.saving = (async () => {
      while (this.savedVersion !== this.state.version) {
        const version = this.state.version;
        const draft = this.state.draft!;
        this.set({ status: "saving", error: "" });
        try {
          const saved = await this.api.saveReportDraft(draft);
          this.savedVersion = version;
          this.savedDraft = saved;
          this.set({
            draft:
              this.state.version === version
                ? saved
                : { ...this.state.draft!, revision: saved.revision },
            status: this.state.version === version ? "saved" : "unsaved",
          });
        } catch (e) {
          this.set({
            status: "error",
            error: e instanceof Error ? e.message : String(e),
          });
          throw e;
        }
      }
    })();
    try {
      await this.saving;
    } finally {
      this.saving = null;
    }
  }
  discard() {
    clearTimeout(this.timer);
    this.savedVersion = this.state.version;
    this.set({ draft: this.savedDraft, status: "saved", error: "" });
  }
  dispose() {
    clearTimeout(this.timer);
  }
}
export class DraftStore {
  private sessions = new Map<string, DraftSession>();
  constructor(private api: Api) {}
  async open(year: number, month: number) {
    const key = year + "-" + month;
    let session = this.sessions.get(key);
    if (!session) {
      session = new DraftSession(this.api, year, month);
      this.sessions.set(key, session);
    }
    try {
      await session.ready;
      return session;
    } catch (e) {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      session.dispose();
      throw e;
    }
  }
  async flushAll() {
    for (const session of this.sessions.values()) await session.flush();
  }
  discardAll() {
    for (const session of this.sessions.values()) session.discard();
  }
  dispose() {
    for (const session of this.sessions.values()) session.dispose();
  }
}
let store: DraftStore | undefined;
export function reportDraftStore() {
  return (store ??= new DraftStore(window.checkinApi));
}
