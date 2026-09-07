import { useCallback, useEffect, useState } from "react";
import type { BootstrapData } from "../shared/contracts";
import { CheckInPage } from "./pages/CheckInPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DataPage } from "./pages/DataPage";
import { RecordsPage } from "./pages/RecordsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AdjustmentsPage } from "./pages/AdjustmentsPage";

export type Page = "checkin" | "dashboard" | "adjustments" | "reports" | "data" | "records" | "settings";

const NAVIGATION: Array<{ key: Page; label: string; auxiliary?: boolean }> = [
  { key: "checkin", label: "签到" },
  { key: "dashboard", label: "看板" },
  { key: "adjustments", label: "请假与加班" },
  { key: "reports", label: "输出本月绩效文件" },
  { key: "records", label: "签到记录", auxiliary: true },
  { key: "data", label: "排班与成员", auxiliary: true },
  { key: "settings", label: "设置", auxiliary: true },
];

export function App() {
  const [page, setPage] = useState<Page>("checkin");
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const data = await window.checkinApi.bootstrap();
      setBootstrap(data);
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <button className="brand" onClick={() => setPage("checkin")} aria-label="返回签到首页">
          <span className="brand-mark">网</span>
          <span>
            <strong>网络服务小组</strong>
            <small>签到与月报</small>
          </span>
        </button>
        <nav className="main-nav" aria-label="主导航">
          {NAVIGATION.filter((item) => !item.auxiliary).map((item) => (
            <button key={item.key} className={page === item.key ? "active" : ""} onClick={() => setPage(item.key)}>
              {item.label}
            </button>
          ))}
        </nav>
        <nav className="aux-nav" aria-label="辅助导航">
          {NAVIGATION.filter((item) => item.auxiliary).map((item) => (
            <button key={item.key} className={page === item.key ? "active" : ""} onClick={() => setPage(item.key)}>
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => void refresh()}>重试</button>
        </div>
      )}

      <main className="app-main">
        {loading && <div className="page-loading">正在读取本地数据…</div>}
        {!loading && bootstrap && page === "checkin" && (
          <CheckInPage data={bootstrap} onChanged={refresh} onOpenRecords={() => setPage("records")} onOpenData={() => setPage("data")} />
        )}
        {!loading && bootstrap && page === "dashboard" && <DashboardPage members={bootstrap.members} />}
        {!loading && bootstrap && page === "adjustments" && <AdjustmentsPage members={bootstrap.members} onChanged={refresh} onOpenRecords={() => setPage("records")} />}
        {!loading && bootstrap && page === "reports" && <ReportsPage members={bootstrap.members} />}
        {!loading && bootstrap && page === "records" && <RecordsPage members={bootstrap.members} onChanged={refresh} />}
        {!loading && bootstrap && page === "data" && <DataPage data={bootstrap} onChanged={refresh} />}
        {!loading && bootstrap && page === "settings" && <SettingsPage data={bootstrap} onChanged={refresh} />}
      </main>
    </div>
  );
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message.replace(/^Error invoking remote method '[^']+':\s*/, "");
  return String(cause);
}
