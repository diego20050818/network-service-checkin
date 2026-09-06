import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { formatLocalDate } from "../../apps/desktop/src/domain/time";
import { DatabaseStore } from "../../apps/desktop/src/main/database";
import { AttendanceService } from "../../apps/desktop/src/main/services/attendance-service";
import { MemberService } from "../../apps/desktop/src/main/services/member-service";
import { addScheduleImport, addShift } from "../../apps/desktop/src/main/services/test-helpers.test-util";

test("桌面应用以隔离渲染进程启动并可访问主要页面", async () => {
  const userData = await mkdtemp(join(tmpdir(), "checkin-e2e-"));
  const appPath = resolve(__dirname, "../../apps/desktop");
  const launchEnv = { ...process.env, NODE_ENV: "test" };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({
    // The managed Windows test runner blocks Chromium's restricted child token;
    // no-sandbox is limited to E2E launches and is never used by the packaged app.
    args: [appPath, `--user-data-dir=${userData}`, "--disable-gpu", "--disable-breakpad", "--no-sandbox"],
    env: launchEnv,
  });
  try {
    const window = await application.firstWindow();
    await expect(window).toHaveTitle("网络服务小组签到与月报");
    await expect(window.getByText("今日无班次")).toBeVisible();
    await expect(window.getByRole("button", { name: "导入排班" })).toBeVisible();
    expect(await window.evaluate(() => typeof (globalThis as unknown as { process?: unknown }).process)).toBe("undefined");

    await window.getByRole("button", { name: "排班与成员", exact: true }).click();
    await expect(window.getByRole("button", { name: "下载排班模板" })).toBeVisible();
    await expect(window.getByRole("button", { name: "下载人员模板" })).toBeVisible();

    await window.getByRole("button", { name: "看板", exact: true }).click();
    await expect(window.getByRole("heading", { name: "出勤与计薪工时" })).toBeVisible();
    await window.getByRole("button", { name: "输出本月绩效文件", exact: true }).click();
    await expect(window.getByRole("heading", { name: "输出本月绩效文件" })).toBeVisible();
    await window.getByRole("button", { name: "设置", exact: true }).click();
    await expect(window.getByRole("heading", { name: "文件存放位置" })).toBeVisible();
    await expect(window.getByRole("heading", { name: "备份管理" })).toBeVisible();
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("打包后的桌面可执行文件可独立启动", async () => {
  const executablePath = resolve(__dirname, "../../apps/desktop/release/win-unpacked/网络服务小组签到与月报.exe");
  test.skip(!existsSync(executablePath), "请先执行 npm run package:win");
  const userData = await mkdtemp(join(tmpdir(), "checkin-packaged-e2e-"));
  const launchEnv = { ...process.env, NODE_ENV: "test" };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`, "--disable-gpu", "--disable-breakpad", "--no-sandbox"],
    env: launchEnv,
  });
  try {
    const window = await application.firstWindow();
    await expect(window).toHaveTitle("网络服务小组签到与月报");
    await expect(window.getByText("今日无班次")).toBeVisible();
    expect(await window.evaluate(() => typeof (globalThis as unknown as { process?: unknown }).process)).toBe("undefined");
    await window.getByRole("button", { name: "设置", exact: true }).click();
    await expect(window.getByRole("switch", { name: "开机自启动" })).toBeEnabled();
    await expect(window.getByRole("heading", { name: "当前使用的文件" })).toBeVisible();
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("无卡片日历看板和文件编辑区适配 1100×700 与 1440×900", async () => {
  const userData = await mkdtemp(join(tmpdir(), "checkin-responsive-e2e-"));
  const dataDirectory = join(userData, "data");
  await mkdir(dataDirectory, { recursive: true });
  const store = new DatabaseStore(join(dataDirectory, "app.sqlite3"));
  const members = new MemberService(store);
  const attendance = new AttendanceService(store, members);
  const today = formatLocalDate(new Date());
  const importId = addScheduleImport(store, today.slice(0, 7));
  const arrived = addShift(store, members, { importId, date: today, kind: "desk", startTime: "00:01", endTime: "00:31", paidMinutes: 30, people: ["甲"] });
  addShift(store, members, { importId, date: today, kind: "desk", startTime: "01:00", endTime: "02:00", paidMinutes: 60, people: ["乙"] });
  addShift(store, members, { importId, date: today, kind: "maintenance", startTime: "23:00", endTime: "23:59", paidMinutes: 59, people: ["甲", "乙", "丙"] });
  const currentHour = new Date().getHours();
  const hasCurrentShift = currentHour < 23;
  if (hasCurrentShift) {
    addShift(store, members, {
      importId,
      date: today,
      kind: "weekend",
      startTime: `${String(currentHour).padStart(2, "0")}:00`,
      endTime: `${String(currentHour + 1).padStart(2, "0")}:00`,
      paidMinutes: 60,
      people: ["丁"],
    });
  }
  attendance.addManual({ slotId: arrived.slotIds[0]!, memberId: arrived.memberIds.甲!, historicalPunchTime: null });
  store.close();
  const appPath = resolve(__dirname, "../../apps/desktop");
  const screenshotDirectory = resolve(__dirname, "screenshots");
  await mkdir(screenshotDirectory, { recursive: true });
  const launchEnv = { ...process.env, NODE_ENV: "test" };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [appPath, `--user-data-dir=${userData}`, "--disable-gpu", "--disable-breakpad", "--no-sandbox"], env: launchEnv });
  try {
    const window = await application.firstWindow();
    await window.setViewportSize({ width: 1100, height: 700 });
    await expect(window.getByRole("heading", { name: `今日共 ${hasCurrentShift ? 4 : 3} 个班次` })).toBeVisible();
    await expect(window.getByText("负责人：").first()).toBeVisible();
    await expect(window.locator(".day-agenda-table")).toBeVisible();
    await expect(window.locator(".shift-card")).toHaveCount(0);
    if (hasCurrentShift) await expect(window.locator(".shift-countdown")).toContainText("距结束");
    await window.screenshot({ path: join(screenshotDirectory, "checkin-settings-1100x700.png"), fullPage: true });
    await window.getByRole("button", { name: "看板", exact: true }).click();
    await expect(window.getByRole("heading", { name: "周班表" })).toBeVisible();
    await expect(window.getByLabel("到岗状态图例")).toContainText("到岗未到岗未到班");
    await expect(window.locator(".weekly-schedule-card")).toHaveCount(0);
    await expect(window.locator(".week-person.arrived")).toContainText("甲");
    await expect(window.getByTitle("乙：未到岗").first()).toBeVisible();
    if (currentHour < 23) await expect(window.locator(".week-person.upcoming").first()).toBeVisible();
    if (currentHour >= 4) expect(await window.getByLabel("周班表日历").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
    await window.screenshot({ path: join(screenshotDirectory, "dashboard-settings-1100x700.png"), fullPage: true });

    await window.getByRole("button", { name: "输出本月绩效文件", exact: true }).click();
    const performanceItem = window.locator(".file-item").filter({ hasText: "全员绩效考核表" });
    await performanceItem.getByRole("button").click();
    await expect(window.getByRole("heading", { name: "工时与评分" })).toBeVisible();
    expect(await window.locator(".report-editor").evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(650);
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
    await window.screenshot({ path: join(screenshotDirectory, "performance-settings-1100x700.png"), fullPage: true });

    await window.setViewportSize({ width: 1440, height: 900 });
    const wageItem = window.locator(".file-item").filter({ hasText: "工资考核表" });
    await wageItem.getByRole("button").click();
    await expect(window.locator(".report-editor").getByRole("heading", { name: "工资考核表", exact: true })).toBeVisible();
    expect(await window.locator(".report-editor").evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(650);
    await window.screenshot({ path: join(screenshotDirectory, "wage-settings-1440x900.png"), fullPage: true });

    await window.setViewportSize({ width: 1100, height: 700 });
    await window.getByRole("button", { name: "设置", exact: true }).click();
    await expect(window.getByRole("heading", { name: "文件存放位置" })).toBeVisible();
    await expect(window.locator(".settings-file-table strong", { hasText: "fixture.xlsx" })).toBeVisible();
    await expect(window.getByRole("heading", { name: "备份管理" })).toBeVisible();
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
    await window.screenshot({ path: join(screenshotDirectory, "settings-1100x700.png"), fullPage: true });
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});
