import { BusinessDataContext } from "./data/invalidation";
import { useCallback, useEffect, useState } from "react";
import type {
  AttendanceReminderPayload,
  BootstrapData,
  OperationEntry,
  RecordFilters,
} from "../shared/contracts";
import { CheckInPage } from "./pages/CheckInPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DataPage } from "./pages/DataPage";
import { RecordsPage } from "./pages/RecordsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AdjustmentsPage } from "./pages/AdjustmentsPage";
import { CalendarPage } from "./pages/CalendarPage";
import { AppButton, AppDialog, UiProvider, useFeedback } from "./ui";
import { reportDraftStore } from "./data/draft-store";
import { checkNavigationGuards } from "./data/navigation";
import { formatLocalDate } from "../domain/time";
import emblem from "./assets/jnu-emblem.svg";

export type Page =
  | "checkin"
  | "calendar"
  | "dashboard"
  | "records"
  | "adjustments"
  | "reports"
  | "data"
  | "settings";
const navigation: Array<{ key: Page; label: string; icon: string }> = [
  { key: "checkin", label: "今日签到", icon: "⌂" },
  { key: "calendar", label: "日历排班", icon: "▦" },
  { key: "dashboard", label: "工时记录", icon: "☷" },
  { key: "adjustments", label: "请假与加班", icon: "⇄" },
  { key: "reports", label: "月度导出", icon: "▤" },
  { key: "data", label: "成员与排班源", icon: "♧" },
  { key: "settings", label: "设置", icon: "⚙" },
];

function playReminderTone(): void {
  try {
    const context = new AudioContext();
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.62);
    gain.connect(context.destination);
    for (const [frequency, offset] of [
      [660, 0],
      [880, 0.2],
    ] as const) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(context.currentTime + offset);
      oscillator.stop(context.currentTime + offset + 0.24);
    }
    window.setTimeout(() => void context.close(), 800);
  } catch {
    // 音频设备不可用时仍保留视觉和系统提醒。
  }
}
export function App() {
  return (
    <UiProvider>
      <Workspace />
    </UiProvider>
  );
}
function Workspace() {
  const [page, setPage] = useState<Page>("checkin");
  const [data, setData] = useState<BootstrapData | null>(null);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(
    () => window.matchMedia("(max-width: 1250px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1250px)");
    const resize = () => setCollapsed(media.matches);
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  const [filters, setFilters] = useState<RecordFilters>({});
  const [history, setHistory] = useState<OperationEntry[] | null>(null);
  const [attendanceReminder, setAttendanceReminder] =
    useState<AttendanceReminderPayload | null>(null);
  const { notify, confirm } = useFeedback();
  const refresh = useCallback(async () => {
    try {
      setData(await window.checkinApi.bootstrap());
      setError("");
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  }, []);
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);
  useEffect(() => {
    document.querySelector(".app-main")?.scrollTo({ top: 0, left: 0 });
  }, [page]);
  const canLeave = useCallback(async () => {
    if (!(await checkNavigationGuards())) return false;
    try {
      await reportDraftStore().flushAll();
      return true;
    } catch (e) {
      const discard = await confirm({
        title: "草稿尚未保存",
        message:
          errorMessage(e) +
          "。当前输入仍保留，可留在页面重试；放弃后只保留上次已保存内容。",
        confirmLabel: "放弃未保存内容",
        cancelLabel: "留在当前页面",
      });
      if (discard) reportDraftStore().discardAll();
      return discard;
    }
  }, [confirm]);
  useEffect(() => window.checkinApi.onCloseRequested(canLeave), [canLeave]);
  useEffect(
    () =>
      window.checkinApi.onAttendanceReminder((payload) => {
        setAttendanceReminder((current) => {
          if (!current) return payload;
          const shifts = new Map(
            [...current.shifts, ...payload.shifts].map((shift) => [
              shift.id,
              shift,
            ]),
          );
          const values = [...shifts.values()];
          return {
            triggeredAt: payload.triggeredAt,
            shifts: values,
            totalPending: values.reduce(
              (count, shift) => count + shift.pendingNames.length,
              0,
            ),
          };
        });
        playReminderTone();
      }),
    [],
  );
  async function navigate(next: Page, context?: RecordFilters) {
    if (!(await canLeave())) return;
    if (context) setFilters(context);
    setPage(next);
  }
  const openRecords = (context?: RecordFilters) => {
    void navigate("records", context);
  };
  const title = navigation.find(
    (n) => n.key === (page === "records" ? "dashboard" : page),
  )!.label;
  async function openHistory() {
    try {
      setHistory(await window.checkinApi.listOperations());
    } catch (e) {
      notify(errorMessage(e));
    }
  }
  async function undo(id: string) {
    await window.checkinApi.undoOperation(id);
    try {
      await refresh();
      setHistory(await window.checkinApi.listOperations());
      notify("操作已撤销");
    } catch {
      notify("已撤销，页面未能刷新。请重新加载。");
    }
  }
  return (
    <BusinessDataContext.Provider value={data}>
      <div
        className={"app-shell workspace " + (collapsed ? "nav-collapsed" : "")}
      >
        <aside className="app-sidebar">
          <AppButton
            variant="quiet"
            className="brand"
            onClick={() => navigate("checkin")}
            aria-label="返回签到首页"
          >
            <span
              className="brand-emblem"
              role="img"
              aria-label="暨南大学校徽"
              style={{ maskImage: `url("${emblem}")` }}
            />
            <span className="brand-copy">
              <strong>网络服务小组</strong>
              <small>暨南大学 · 签到与月报</small>
            </span>
          </AppButton>
          <span className="sidebar-caption">工作区</span>
          <nav aria-label="主导航">
            {navigation.map((item) => (
              <AppButton
                key={item.key}
                variant="quiet"
                aria-label={item.label}
                aria-current={
                  page === item.key ||
                  (page === "records" && item.key === "dashboard")
                    ? "page"
                    : undefined
                }
                className={
                  page === item.key ||
                  (page === "records" && item.key === "dashboard")
                    ? "active"
                    : ""
                }
                onClick={() => navigate(item.key)}
              >
                <span className="nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span className="nav-label">{item.label}</span>
              </AppButton>
            ))}
          </nav>
          <footer>
            <span className="local-state">
              <i />
              本地数据 · v0.6.0
            </span>
            <AppButton
              variant="quiet"
              aria-label={collapsed ? "展开导航" : "收起导航"}
              onClick={() => setCollapsed(!collapsed)}
            >
              {collapsed ? "»" : "«"}
            </AppButton>
          </footer>
        </aside>
        <div className="workspace-body">
          <header className="workspace-header">
            <span>
              网络服务小组 <i>/</i> <strong>{title}</strong>
            </span>
            <AppButton variant="quiet" onClick={openHistory}>
              ↶ 最近操作
            </AppButton>
          </header>
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <AppButton onClick={() => refresh().catch(() => undefined)}>
                重新加载
              </AppButton>
            </div>
          )}
          <main className="app-main">
            {!data && !error && (
              <div className="page-loading">正在读取本地数据…</div>
            )}
            {data && (
              <>
                {page === "checkin" && (
                  <CheckInPage
                    data={data}
                    onChanged={refresh}
                    onOpenData={() => {
                      void navigate("data");
                    }}
                    onOpenRecords={() => {
                      const date = formatLocalDate(new Date());
                      openRecords({ startDate: date, endDate: date });
                    }}
                  />
                )}
                {page === "calendar" && (
                  <CalendarPage
                    members={data.members}
                    onChanged={refresh}
                    onOpenRecords={openRecords}
                  />
                )}
                {(page === "dashboard" || page === "records") && (
                  <div className="workspace-tabs" aria-label="工时视图">
                    <AppButton
                      variant="quiet"
                      className={page === "dashboard" ? "active" : ""}
                      onClick={() => navigate("dashboard")}
                    >
                      工时汇总
                    </AppButton>
                    <AppButton
                      variant="quiet"
                      className={page === "records" ? "active" : ""}
                      onClick={() => navigate("records")}
                    >
                      签到明细
                    </AppButton>
                  </div>
                )}
                {page === "dashboard" && (
                  <DashboardPage
                    members={data.members}
                    onOpenRecords={openRecords}
                    context={filters}
                    onContextChange={setFilters}
                  />
                )}
                {page === "records" && (
                  <RecordsPage
                    members={data.members}
                    onChanged={refresh}
                    context={filters}
                    onContextChange={setFilters}
                  />
                )}
                {page === "adjustments" && (
                  <AdjustmentsPage
                    members={data.members}
                    onChanged={refresh}
                    onOpenRecords={() => openRecords()}
                  />
                )}
                {page === "reports" && <ReportsPage members={data.members} />}
                {page === "data" && (
                  <DataPage data={data} onChanged={refresh} />
                )}
                {page === "settings" && (
                  <SettingsPage data={data} onChanged={refresh} />
                )}
              </>
            )}
          </main>
        </div>
        {attendanceReminder && (
          <div
            className="attendance-reminder-overlay"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="attendance-reminder-title"
          >
            <div className="attendance-reminder-rings" aria-hidden="true" />
            <section className="attendance-reminder-card">
              <span className="attendance-reminder-icon" aria-hidden="true">
                !
              </span>
              <div>
                <p>开班已满 15 分钟</p>
                <h2 id="attendance-reminder-title">
                  {attendanceReminder.totalPending} 人尚未签到
                </h2>
                <div className="attendance-reminder-shifts">
                  {attendanceReminder.shifts.map((shift) => (
                    <p key={shift.id}>
                      <strong>{shift.label}</strong>
                      <span>
                        {shift.startTime}–{shift.endTime} ·{" "}
                        {shift.pendingNames.join("、")}
                      </span>
                    </p>
                  ))}
                </div>
              </div>
              <div className="button-row">
                <AppButton
                  variant="primary"
                  onClick={() => {
                    setAttendanceReminder(null);
                    void navigate("checkin");
                  }}
                >
                  去签到
                </AppButton>
                <AppButton onClick={() => setAttendanceReminder(null)}>
                  关闭提醒
                </AppButton>
              </div>
            </section>
          </div>
        )}
        <AppDialog
          open={history !== null}
          title="最近操作"
          drawer
          onClose={() => setHistory(null)}
        >
          <p>本机最近 100 次操作。后续数据变化时，请从对应记录详情更正。</p>
          <div className="operation-list">
            {history?.map((op) => (
              <div className="operation-row" key={op.id}>
                <div>
                  <strong>{op.label}</strong>
                  <small>
                    {new Date(op.createdAt).toLocaleString("zh-CN")}
                  </small>
                </div>
                <AppButton disabled={!op.canUndo} onClick={() => undo(op.id)}>
                  {op.undoneAt
                    ? "已撤销"
                    : op.canUndo
                      ? "撤销"
                      : "后续数据已变化"}
                </AppButton>
              </div>
            ))}
          </div>
        </AppDialog>
      </div>
    </BusinessDataContext.Provider>
  );
}
export function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message.replace(/^Error invoking remote method '[^']+':\s*/, "")
    : String(cause);
}
