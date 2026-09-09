import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import ExcelJS from "exceljs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { formatLocalDate } from "../../apps/desktop/src/domain/time";
import { DatabaseStore } from "../../apps/desktop/src/main/database";
import { AttendanceService } from "../../apps/desktop/src/main/services/attendance-service";
import { MemberService } from "../../apps/desktop/src/main/services/member-service";
import {
  addScheduleImport,
  addShift,
} from "../../apps/desktop/src/main/services/test-helpers.test-util";
import { IPC_CHANNELS } from "../../apps/desktop/src/shared/ipc-channels";

const active: Array<{ app: ElectronApplication; directory: string }> = [];
test.afterEach(async ({}, info) => {
  for (const { app, directory } of active.splice(0)) {
    if (info.status !== info.expectedStatus) {
      const page = app.windows()[0];
      if (page)
        await page
          .screenshot({ path: info.outputPath("failure.png"), fullPage: true })
          .catch(() => undefined);
    }
    await app.evaluate(({ app }) => app.exit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
async function launchFixture() {
  const directory = await mkdtemp(join(tmpdir(), "checkin-v063-e2e-"));
  const data = join(directory, "data");
  await mkdir(data, { recursive: true });
  const store = new DatabaseStore(join(data, "app.sqlite3"));
  const members = new MemberService(store);
  const attendance = new AttendanceService(store, members);
  const today = formatLocalDate(new Date());
  const importId = addScheduleImport(store, today.slice(0, 7));
  const current = addShift(store, members, {
    importId,
    date: today,
    kind: "maintenance",
    startTime: "00:00",
    endTime: "23:59",
    paidMinutes: 1439,
    people: ["林清", "陈嘉", "周宁"],
  });
  members.save({
    name: "何悦",
    college: "信息科学技术学院",
    studentId: "00123456",
  });
  const ended = addShift(store, members, {
    importId,
    date: today,
    kind: "maintenance",
    startTime: "00:01",
    endTime: "00:06",
    paidMinutes: 5,
    people: ["陈嘉"],
  });
  attendance.addManual({
    slotId: ended.slotIds[0]!,
    memberId: ended.memberIds.陈嘉!,
  });
  const next = new Date();
  next.setDate(next.getDate() + 1);
  const tomorrow = formatLocalDate(next);
  const future = addShift(store, members, {
    importId,
    date: tomorrow,
    kind: "maintenance",
    startTime: "09:07",
    endTime: "10:22",
    paidMinutes: 75,
    people: ["林清"],
  });
  addShift(store, members, {
    importId,
    date: tomorrow,
    kind: "desk",
    startTime: "09:30",
    endTime: "10:00",
    paidMinutes: 30,
    people: ["何悦"],
  });
  addShift(store, members, {
    importId,
    date: tomorrow,
    kind: "maintenance",
    startTime: "10:22",
    endTime: "10:27",
    paidMinutes: 5,
    people: ["林清"],
  });
  addShift(store, members, {
    importId,
    date: tomorrow,
    kind: "desk",
    startTime: "10:27",
    endTime: "10:32",
    paidMinutes: 5,
    people: ["陈嘉"],
  });
  store.close();
  const env = { ...process.env, NODE_ENV: "test" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [
      resolve(__dirname, "../../apps/desktop"),
      "--user-data-dir=" + directory,
      "--disable-gpu",
      "--disable-breakpad",
      "--no-sandbox",
    ],
    env,
  });
  active.push({ app, directory });
  const page = await app.firstWindow();
  await expect(
    page.getByRole("heading", { name: "今日签到", exact: true }),
  ).toBeVisible();
  return { app, page, directory, today, tomorrow, current, future };
}
async function nav(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function member(page: Page, label: string, name: string) {
  const field = page.getByRole("combobox", { name: label, exact: true });
  await field.fill(name);
  await page.getByRole("option").filter({ hasText: name }).first().click();
}

test("隔离渲染器、主页面与无横向溢出", async () => {
  const { page } = await launchFixture();
  expect(
    await page.evaluate(
      () => typeof (globalThis as { process?: unknown }).process,
    ),
  ).toBe("undefined");
  for (const name of [
    "成员与排班源",
    "工时记录",
    "请假与加班",
    "月度导出",
    "设置",
    "日历排班",
  ]) {
    await nav(page, name);
    await expect(
      page.getByRole("heading", {
        name: name === "工时记录" ? "工时汇总" : name,
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await expect(page.locator(".full-calendar")).toBeVisible();
  await expect(page.locator(".occurrence-event").first()).toBeAttached();
});

test("成员编辑使用独立会话，取消保留旧资料", async () => {
  const { page } = await launchFixture();
  await nav(page, "成员与排班源");
  await page.getByRole("button", { name: "编辑 林清", exact: true }).click();
  await page
    .getByRole("textbox", { name: "姓名", exact: true })
    .fill("错误名字");
  await page
    .getByRole("dialog", { name: "编辑 林清" })
    .getByText("取消", { exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "成员资料尚未保存" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await page.getByRole("button", { name: "编辑 陈嘉", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "姓名", exact: true }),
  ).toHaveValue("陈嘉");
  await page
    .getByRole("textbox", { name: "所属学院", exact: true })
    .fill("测试学院");
  await page.getByRole("button", { name: "保存成员", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "编辑 陈嘉" })).toHaveCount(0);
  const result = await page.evaluate(() => window.checkinApi.listMembers());
  expect(result.find((m) => m.name === "林清")?.college).toBe("");
  expect(result.find((m) => m.name === "陈嘉")?.college).toBe("测试学院");
});

test("650ms 内切页、切月以及正常关窗都会保存最新草稿", async () => {
  const { page, app, directory } = await launchFixture();
  await nav(page, "月度导出");
  const advice = page.getByRole("textbox", {
    name: "完成的工作 1",
    exact: true,
  });
  await advice.fill("快速切页也应保存");
  await nav(page, "设置");
  await nav(page, "月度导出");
  await expect(advice).toHaveValue("快速切页也应保存");
  await advice.fill("切月前的最后输入");
  const period = page.getByLabel("所属月份", { exact: true });
  const value = await period.inputValue();
  const [year, month] = value.split("-").map(Number);
  const next = new Date(year!, month!, 1);
  const nextKey = formatLocalDate(next).slice(0, 7);
  await period.fill(nextKey);
  await expect(period).toHaveValue(nextKey);
  await expect(advice).toHaveValue("");
  await period.fill(value);
  await expect(advice).toHaveValue("切月前的最后输入");
  await advice.fill("关窗前最后输入");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.close();
  });
  await expect.poll(async () => app.windows().length).toBe(0);
  const probe = new DatabaseStore(join(directory, "data", "app.sqlite3"));
  try {
    const row = probe
      .prepare(
        "SELECT payload_json FROM report_drafts WHERE year=? AND month=?",
      )
      .get(year!, month!);
    expect(JSON.parse(String(row!.payload_json)).workItems[0]).toBe(
      "关窗前最后输入",
    );
  } finally {
    probe.close();
  }
});

test("人员搜索不沿用旧 ID，增员、移除、恢复保持原席位", async () => {
  const { page, current } = await launchFixture();
  const row = page.locator(".agenda-row.current").first();
  await row.getByRole("button", { name: "添加办公人员", exact: false }).click();
  const search = page.getByRole("combobox", {
    name: "添加办公人员",
    exact: true,
  });
  await search.fill("不存在的人员");
  await search.press("Escape");
  await expect(
    page.getByRole("button", { name: "加入本班", exact: true }),
  ).toBeDisabled();
  await search.fill("何悦");
  await page.getByRole("option").filter({ hasText: "何悦" }).click();
  await page.getByRole("button", { name: "加入本班", exact: true }).click();
  await expect(
    row.locator(".person-label").filter({ hasText: "何悦" }),
  ).toBeVisible();
  const before = await page.evaluate(
    (id) =>
      window.checkinApi
        .listOccurrences({
          startDate: new Date().toLocaleDateString("en-CA"),
          endDate: new Date().toLocaleDateString("en-CA"),
        })
        .then((s) => s.find((s) => s.id === id)),
    current.shiftId,
  );
  const added = before!.slots.find((s) => s.scheduledMemberName === "何悦")!;
  await row.getByRole("button", { name: "何悦的操作", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "移除临时席位", exact: true })
    .click();
  await expect(
    row.locator(".person-label").filter({ hasText: "何悦" }),
  ).toHaveCount(0);
  await row.getByRole("button", { name: /已撤销与已移除/ }).click();
  await page.getByRole("button", { name: "恢复席位", exact: true }).click();
  const after = await page.evaluate(
    (id) =>
      window.checkinApi
        .getShiftsForDate(new Date().toLocaleDateString("en-CA"))
        .then((s) => s.find((s) => s.id === id)),
    current.shiftId,
  );
  expect(after!.slots.find((s) => s.scheduledMemberName === "何悦")!.id).toBe(
    added.id,
  );
});

test("签到重复提交防护及批量撤销只撤销本次新记录", async () => {
  const { page, current, today } = await launchFixture();
  const row = page.locator(".agenda-row.current").first();
  await row
    .getByRole("checkbox", { name: "选择 林清 签到", exact: true })
    .press("Space");
  await row
    .getByRole("button", { name: "为所选 1 人签到", exact: true })
    .dblclick();
  await expect(
    row.locator(".person-label").filter({ hasText: "林清" }),
  ).toBeVisible();
  const records = await page.evaluate(
    (today) =>
      window.checkinApi.listRecords({
        startDate: today,
        endDate: today,
        includeRevoked: true,
      }),
    today,
  );
  expect(
    records.filter(
      (r) => r.shiftId === current.shiftId && r.status === "active",
    ),
  ).toHaveLength(1);
  await page
    .locator(".ui-toast")
    .getByRole("button", { name: "撤销", exact: true })
    .click();
  const after = await page.evaluate(
    (today) =>
      window.checkinApi.listRecords({
        startDate: today,
        endDate: today,
        includeRevoked: true,
      }),
    today,
  );
  expect(
    after.filter((r) => r.shiftId === current.shiftId && r.status === "active"),
  ).toHaveLength(0);
  expect(
    after.filter((r) => r.shiftId !== current.shiftId && r.status === "active"),
  ).toHaveLength(1);
});

test("写入成功但刷新失败不会报告写入失败或重写", async () => {
  const { app, page, today } = await launchFixture();
  await app.evaluate(({ ipcMain }, channel) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, () => {
      throw new Error("injected refresh failure");
    });
  }, IPC_CHANNELS.bootstrap);
  const row = page.locator(".agenda-row.current").first();
  await row
    .getByRole("checkbox", { name: "选择 林清 签到", exact: true })
    .press("Space");
  await row
    .getByRole("button", { name: "为所选 1 人签到", exact: true })
    .click();
  await expect(
    page.getByText("已保存，但刷新失败。请重新加载，不要重复提交。", {
      exact: true,
    }),
  ).toBeVisible();
  const records = await page.evaluate(
    (date) => window.checkinApi.listRecords({ startDate: date, endDate: date }),
    today,
  );
  expect(records.filter((r) => r.actualMemberName === "林清")).toHaveLength(1);
});

test("关键页面在指定分辨率和缩放下留档", async () => {
  const { page, app } = await launchFixture();
  const directory = resolve(__dirname, "screenshots", "v0.6.3");
  await mkdir(directory, { recursive: true });
  for (const [width, height, scale] of [
    [760, 540, 1],
    [950, 700, 1],
    [1366, 768, 1],
    [1920, 1080, 1],
    [1366, 768, 1.25],
    [1366, 768, 1.5],
  ] as const) {
    await page.setViewportSize({ width, height });
    await app.evaluate(
      ({ BrowserWindow }, zoom) =>
        BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(zoom),
      scale,
    );
    for (const [name, key] of [
      ["今日签到", "checkin"],
      ["日历排班", "calendar"],
      ["月度导出", "reports"],
      ["成员与排班源", "members"],
      ["设置", "settings"],
    ] as const) {
      await nav(page, name);
      await expect(page.locator(".page-header")).toBeVisible();
      if (name === "日历排班")
        await expect(page.locator(".occurrence-event").first()).toBeAttached();
      if (name === "月度导出")
        await expect(page.getByText("文件目录", { exact: true })).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const sidebar = await page.locator(".app-sidebar").boundingBox();
      const viewportHeight = await page.evaluate(() => innerHeight);
      expect(
        Math.abs(sidebar!.y + sidebar!.height - viewportHeight),
      ).toBeLessThanOrEqual(1);
      await page.locator(".app-main").evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const scrolledSidebar = await page.locator(".app-sidebar").boundingBox();
      expect(
        Math.abs(scrolledSidebar!.y + scrolledSidebar!.height - viewportHeight),
      ).toBeLessThanOrEqual(1);
      await page.locator(".app-main").evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.screenshot({
        path: join(directory, `${key}-${width}x${height}-${scale}.png`),
        fullPage: false,
        scale: "css",
      });
    }
  }
});

test("日历按分钟编辑、取消及恢复，重载后保留时间与原 ID", async () => {
  const { page, future, tomorrow } = await launchFixture();
  await nav(page, "日历排班");
  const event = page.locator('.occurrence-event[aria-label*="09:07"]');
  // Tomorrow may fall in the next week.
  if (!(await event.count()))
    await page.getByRole("button", { name: "下一周或日", exact: true }).click();
  await event.click();
  await page.getByRole("button", { name: "编辑本次", exact: true }).click();
  await page
    .getByRole("textbox", { name: "备注", exact: true })
    .fill("分钟时间保持原样");
  await page.getByRole("button", { name: "保存本次安排", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "编辑本次班次", exact: true }),
  ).toHaveCount(0);
  const saved = await page.evaluate(
    ({ tomorrow, id }) =>
      window.checkinApi
        .listOccurrences({ startDate: tomorrow, endDate: tomorrow })
        .then((rows) => rows.find((s) => s.id === id)),
    { tomorrow, id: future.shiftId },
  );
  expect(saved).toMatchObject({
    id: future.shiftId,
    startTime: "09:07",
    endTime: "10:22",
    paidMinutes: 75,
    note: "分钟时间保持原样",
  });
  await event.focus();
  await event.press("Enter");
  await expect(
    page.getByText("分钟时间保持原样", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消本次班次", exact: true }).click();
  await page.getByRole("button", { name: "取消班次", exact: true }).click();
  await expect(event).toHaveCount(0);
  await page.getByRole("button", { name: /查看已取消的班次/ }).click();
  await page.getByRole("button", { name: "详情与恢复", exact: true }).click();
  await page.getByRole("button", { name: "恢复本次班次", exact: true }).click();
  await expect(event).toHaveCount(1);
  await page.reload();
  await nav(page, "日历排班");
  if (!(await event.count()))
    await page.getByRole("button", { name: "下一周或日", exact: true }).click();
  await expect(event).toHaveCount(1);
  const shortA = page.locator('.occurrence-event[title*=" 10:22–"]');
  const shortB = page.locator('.occurrence-event[title*=" 10:27–"]');
  const a = await shortA.boundingBox();
  const b = await shortB.boundingBox();
  expect(a!.y + a!.height).toBeLessThanOrEqual(b!.y + 1);
  await page.locator(".calendar-toolbar .ui-select-trigger").click();
  await page.getByRole("option", { name: "日视图", exact: true }).click();
  await expect(page.locator(".full-calendar")).toBeVisible();
});

test("三人维修班多选在目标尺寸和缩放下填满工作区且不溢出", async () => {
  const { page, app } = await launchFixture();
  const row = page.locator(".agenda-row.current").first();
  await expect(row.getByRole("heading", { name: "维修班" })).toBeVisible();
  await row
    .getByRole("button", { name: "选择全部待签到", exact: true })
    .click();
  await expect(
    row.getByRole("button", { name: "为所选 3 人签到", exact: true }),
  ).toBeEnabled();

  for (const [width, height, zoom] of [
    [760, 540, 1],
    [950, 700, 1],
    [1366, 768, 1],
    [1920, 1080, 1],
    [1366, 768, 1.25],
    [1366, 768, 1.5],
  ] as const) {
    await page.setViewportSize({ width, height });
    await app.evaluate(
      ({ BrowserWindow }, scale) =>
        BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(scale),
      zoom,
    );
    await expect(row).toBeVisible();
    const layout = await page.evaluate(() => {
      const root = document.documentElement;
      const main = document.querySelector<HTMLElement>(".app-main")!;
      const checkin = document.querySelector<HTMLElement>(".checkin-page")!;
      const mainStyle = getComputedStyle(main);
      const mainBox = main.getBoundingClientRect();
      const pageBox = checkin.getBoundingClientRect();
      const people = Array.from(
        document.querySelectorAll<HTMLElement>(".attendance-person"),
      );
      return {
        noHorizontalOverflow: root.scrollWidth <= root.clientWidth,
        rightGap:
          mainBox.left +
          main.clientWidth -
          Number.parseFloat(mainStyle.paddingRight) -
          pageBox.right,
        peopleInside:
          people.length >= 3 &&
          people.every((person) => {
            const box = person.getBoundingClientRect();
            return box.left >= pageBox.left - 1 && box.right <= pageBox.right + 1;
          }),
      };
    });
    expect(layout.noHorizontalOverflow).toBe(true);
    expect(Math.abs(layout.rightGap)).toBeLessThanOrEqual(1);
    expect(layout.peopleInside).toBe(true);
  }
});

test("设置页可修改 7 条班次时段并持久化自动工时", async () => {
  const { page } = await launchFixture();
  await nav(page, "设置");
  await expect(
    page.getByRole("heading", { name: "班次时段", exact: true }),
  ).toBeVisible();
  for (const label of ["周末上午开始时间", "周末上午结束时间"]) {
    const minute = page
      .getByRole("group", { name: label, exact: true })
      .getByRole("spinbutton")
      .nth(1);
    await minute.click();
    await minute.press("1");
    await minute.press("5");
  }
  await expect(
    page
      .getByRole("group", { name: "周末上午", exact: true })
      .getByText("计入工时：3 小时", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "保存班次时段", exact: true })
    .click();
  await expect(
    page.getByText("班次时段已保存，同步 0 个正式班次", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.checkinApi.getShiftTimeSettings())).toMatchObject({
    weekendMorning: { startTime: "09:15", endTime: "12:15" },
  });
  await nav(page, "成员与排班源");
  await nav(page, "设置");
  await expect(
    page.getByRole("group", { name: "周末上午开始时间", exact: true }),
  ).toContainText("9:15");
});

test("签到倒计时、折叠状态标记和全窗口超时提醒可用", async () => {
  const { page, app, current, future, today } = await launchFixture();
  const row = page.locator(".agenda-row.current").first();
  await expect(row.getByLabel("距离当前班结束", { exact: true })).toBeVisible();
  await row
    .getByRole("checkbox", { name: "选择 林清 签到", exact: true })
    .press("Space");
  await row
    .getByRole("button", { name: "为所选 1 人签到", exact: true })
    .click();
  await expect(row.locator(".attendance-check-pop")).toHaveCount(1);
  await row.locator(".agenda-toggle").click();
  const collapsed = row.getByLabel("折叠签到状态", { exact: true });
  await expect(collapsed).toContainText("✓ 林清");
  await expect(collapsed).toContainText("× 陈嘉");
  await expect(collapsed).toContainText("× 周宁");

  await nav(page, "日历排班");
  await expect(
    page.locator(`[data-occurrence-id="${current.shiftId}"]`),
  ).toHaveClass(/attendance-attention/);
  await expect(
    page.locator(`[data-occurrence-id="${future.shiftId}"]`),
  ).toHaveClass(/attendance-upcoming/);
  await nav(page, "设置");
  await app.evaluate(
    ({ BrowserWindow }, input) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send(
        input.channel,
        input.payload,
      ),
    {
      channel: IPC_CHANNELS.attendanceReminder,
      payload: {
        triggeredAt: new Date().toISOString(),
        totalPending: 2,
        shifts: [
          {
            id: current.shiftId,
            date: today,
            label: "维修班",
            startTime: "00:00",
            endTime: "23:59",
            pendingNames: ["陈嘉", "周宁"],
          },
        ],
      },
    },
  );
  const reminder = page.getByRole("alertdialog");
  await expect(reminder).toContainText("2 人尚未签到");
  await expect(reminder).toContainText("陈嘉、周宁");
  await reminder.getByRole("button", { name: "去签到", exact: true }).click();
  await expect(reminder).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "今日签到", exact: true }),
  ).toBeVisible();
});

test("页面与细节动效使用统一短时长并支持减少动态效果", async () => {
  const { page } = await launchFixture();
  await nav(page, "日历排班");
  await expect(page.locator(".occurrence-event").first()).toBeAttached();
  expect(
    await page.locator(".page-transition").evaluate((element) => ({
      name: getComputedStyle(element).animationName,
      duration: getComputedStyle(element).animationDuration,
    })),
  ).toEqual({ name: "page-enter", duration: "0.19s" });
  expect(
    await page.locator(".occurrence-event").first().evaluate((element) =>
      getComputedStyle(element).animationDuration,
    ),
  ).toBe("0.22s");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await nav(page, "设置");
  expect(
    await page.locator(".page-transition").evaluate((element) => ({
      animation: getComputedStyle(element).animationName,
      transition: getComputedStyle(element).transitionDuration,
    })),
  ).toEqual({ animation: "none", transition: "0s" });
});

test("草稿写入失败可以取消离开，保留输入并重试", async () => {
  const { app, page } = await launchFixture();
  await nav(page, "月度导出");
  await app.evaluate(({ ipcMain }, channel) => {
    const main = ipcMain as typeof ipcMain & {
      _invokeHandlers: Map<string, unknown>;
    };
    const previous = main._invokeHandlers.get(channel);
    (globalThis as any).__savedDraftHandler = previous;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, () => {
      throw new Error("injected disk full");
    });
  }, IPC_CHANNELS.saveReportDraft);
  const input = page.getByRole("textbox", {
    name: "完成的工作 1",
    exact: true,
  });
  await input.fill("保存失败也不丢失");
  await nav(page, "设置");
  await expect(
    page.getByRole("heading", { name: "草稿尚未保存", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "留在当前页面", exact: true }).click();
  await expect(input).toHaveValue("保存失败也不丢失");
  await app.evaluate(({ ipcMain }, channel) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (globalThis as any).__savedDraftHandler);
  }, IPC_CHANNELS.saveReportDraft);
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await nav(page, "设置");
  await nav(page, "月度导出");
  await expect(input).toHaveValue("保存失败也不丢失");
});

test("旧预览迟到不能覆盖新的草稿和预览", async () => {
  const { app, page } = await launchFixture();
  await nav(page, "月度导出");
  await app.evaluate(({ ipcMain }, channel) => {
    const main = ipcMain as typeof ipcMain & {
      _invokeHandlers: Map<string, Function>;
    };
    const original = main._invokeHandlers.get(channel)!;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, draft) => {
      const result = await original(event, draft);
      if (draft.workItems[0] === "旧输入")
        await new Promise((resolve) => setTimeout(resolve, 1400));
      return result;
    });
  }, IPC_CHANNELS.previewReports);
  const input = page.getByRole("textbox", {
    name: "完成的工作 1",
    exact: true,
  });
  await input.fill("旧输入");
  await expect
    .poll(
      async () =>
        await app.evaluate(
          ({ ipcMain }, channel) =>
            Boolean((ipcMain as any)._invokeHandlers.get(channel)),
          IPC_CHANNELS.previewReports,
        ),
    )
    .toBe(true);
  await page.waitForTimeout(300);
  await input.fill("最新输入");
  await page.getByRole("button", { name: "内容预览", exact: true }).click();
  await expect(page.locator(".preview-document")).toContainText("最新输入");
  await page.waitForTimeout(1600);
  await expect(page.locator(".preview-document")).toContainText("最新输入");
  await expect(page.locator(".preview-document")).not.toContainText("旧输入");
});

test("日历拖动持久化，拉伸保存失败复原布局和数据库", async () => {
  const { app, page, future, tomorrow } = await launchFixture();
  await nav(page, "日历排班");
  const event = page.locator(`[data-occurrence-id="${future.shiftId}"]`);
  if (!(await event.count()))
    await page.getByRole("button", { name: "下一周或日", exact: true }).click();
  await expect(event).toBeVisible();
  const before = await event.boundingBox();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + 20);
  await page.mouse.down();
  await page.mouse.move(
    before!.x + before!.width / 2,
    before!.y + 20 + before!.height * 0.8,
    { steps: 15 },
  );
  await page.mouse.up();
  await page.getByRole("button", { name: "保存本次修改", exact: true }).click();
  const fetch = () =>
    page.evaluate(
      ({ date, id }) =>
        window.checkinApi
          .listOccurrences({ startDate: date, endDate: date })
          .then((s) => s.find((s) => s.id === id)),
      { date: tomorrow, id: future.shiftId },
    );
  await expect.poll(async () => (await fetch())!.startTime).not.toBe("09:07");
  const moved = (await fetch())!;
  expect(moved.paidMinutes).toBe(75);
  expect(moved.slots[0]!.id).toBe(future.slotIds[0]);
  await expect(event).toHaveAttribute("title", new RegExp(moved.startTime));
  await app.evaluate(({ ipcMain }, channel) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, () => {
      throw new Error("injected calendar write failure");
    });
  }, IPC_CHANNELS.saveOccurrence);
  const box = await event.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height + 36, {
    steps: 15,
  });
  await page.mouse.up();
  await page.getByRole("button", { name: "保存本次修改", exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "injected calendar write failure" }),
  ).toBeVisible();
  expect(await fetch()).toMatchObject({
    startTime: moved.startTime,
    endTime: moved.endTime,
    paidMinutes: 75,
  });
  await expect
    .poll(async () =>
      Math.abs((await event.boundingBox())!.height - box!.height),
    )
    .toBeLessThanOrEqual(1);
});

test("导入成员须先预览，应用后更新成员列表并保留学号前导零", async () => {
  const { app, page, directory } = await launchFixture();
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("成员").addRows([
    ["姓名", "学号", "学院"],
    ["新成员", "00012345", "信息学院"],
  ]);
  const path = join(directory, "members.xlsx");
  await workbook.xlsx.writeFile(path);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, path);
  await nav(page, "成员与排班源");
  await page
    .getByRole("button", { name: "选择成员信息表并预览", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "导入预览", exact: true }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.checkinApi.listMembers())).some(
      (m) => m.name === "新成员",
    ),
  ).toBe(false);
  await page
    .getByRole("button", { name: "确认应用导入", exact: true })
    .dblclick();
  await expect(
    page.getByRole("dialog", { name: "导入预览", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "编辑 新成员", exact: true }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.checkinApi.listMembers())).find(
      (m) => m.name === "新成员",
    )?.studentId,
  ).toBe("00012345");
});

test("最近操作撤销后立即刷新当前记录页", async () => {
  const { page } = await launchFixture();
  const row = page.locator(".agenda-row.current").first();
  await row
    .getByRole("checkbox", { name: "选择 林清 签到", exact: true })
    .press("Space");
  await row
    .getByRole("button", { name: "为所选 1 人签到", exact: true })
    .click();
  await nav(page, "工时记录");
  await page.getByRole("button", { name: "签到明细", exact: true }).click();
  const record = page.locator("tbody tr").filter({ hasText: "林清" });
  await expect(record).not.toContainText("已撤销");
  await page.getByRole("button", { name: /最近操作/ }).click();
  await page
    .getByRole("dialog", { name: "最近操作", exact: true })
    .getByRole("button", { name: "撤销", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "最近操作", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(record).toContainText("已撤销");
});

test("0.5.1 二进制产生的真实 v3 数据由候选二进制备份并升级", async () => {
  const oldExe = resolve(
    __dirname,
    "../../.tmp/v051-binary/网络服务小组签到与月报.exe",
  );
  const candidateExe = resolve(
    __dirname,
    "../../apps/desktop/release/candidate-0.6.3/win-unpacked/网络服务小组签到与月报.exe",
  );
  test.skip(
    !existsSync(oldExe) || !existsSync(candidateExe),
    "先保留 0.5.1 解包目录并构建 0.6.3 候选包",
  );
  const directory = await mkdtemp(join(tmpdir(), "checkin-binary-upgrade-"));
  const env = { ...process.env, NODE_ENV: "test" };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [
    "--user-data-dir=" + directory,
    "--disable-gpu",
    "--disable-breakpad",
    "--no-sandbox",
  ];
  const old = await electron.launch({ executablePath: oldExe, args, env });
  try {
    expect(await old.evaluate(({ app }) => app.getVersion())).toBe("0.5.1");
    const page = await old.firstWindow();
    await page.waitForFunction(() => Boolean(window.checkinApi));
    await page.evaluate(async () => {
      const member = await window.checkinApi.saveMember({
        name: "旧版验收成员",
        studentId: "00001234",
      });
      const overtime = await window.checkinApi.createOvertime({
        date: "2026-09-01",
        startTime: "09:07",
        endTime: "10:22",
        memberId: member.id,
      });
      await window.checkinApi.addManualAttendance({
        slotId: overtime.slotId,
        memberId: member.id,
      });
      const draft = await window.checkinApi.getReportDraft(2026, 9);
      await window.checkinApi.saveReportDraft({
        ...draft,
        advice: "旧安装包生成的草稿",
      });
    });
  } finally {
    await old.close();
  }
  const database = join(directory, "data", "app.sqlite3");
  const previous = new DatabaseSync(database, { readOnly: true });
  const tables = [
    "members",
    "shifts",
    "shift_slots",
    "attendance_records",
    "report_drafts",
  ];
  const before = Object.fromEntries(
    tables.map((name) => [
      name,
      previous.prepare("SELECT * FROM " + name + " ORDER BY id").all(),
    ]),
  );
  expect(previous.prepare("PRAGMA user_version").get()!.user_version).toBe(3);
  previous.close();
  const app = await electron.launch({
    executablePath: candidateExe,
    args,
    env,
  });
  active.push({ app, directory });
  const page = await app.firstWindow();
  expect(
    await app.evaluate(({ app }) => ({
      version: app.getVersion(),
      packaged: app.isPackaged,
    })),
  ).toEqual({ version: "0.6.3", packaged: true });
  await expect(
    page.getByRole("heading", { name: "今日签到", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => typeof (globalThis as { process?: unknown }).process,
    ),
  ).toBe("undefined");
  await nav(page, "设置");
  const updates = await page.evaluate(() => window.checkinApi.getUpdateState());
  expect(updates.currentVersion).toBe("0.6.3");
  expect(updates.supported).toBe(true);
  const probe = new DatabaseSync(database, { readOnly: true });
  try {
    for (const table of tables) {
      const columns = Object.keys(before[table]![0]!);
      expect(
        probe
          .prepare(
            "SELECT " + columns.join(",") + " FROM " + table + " ORDER BY id",
          )
          .all(),
      ).toEqual(before[table]);
    }
    expect(probe.prepare("PRAGMA user_version").get()!.user_version).toBe(4);
  } finally {
    probe.close();
  }
  const upgrades = join(directory, "data", "upgrade-backups");
  const folders = await readdir(upgrades);
  expect(folders).toHaveLength(1);
  const manifest = JSON.parse(
    await readFile(join(upgrades, folders[0]!, "manifest.json"), "utf8"),
  );
  const backup = new DatabaseSync(join(upgrades, folders[0]!, "app.sqlite3"), {
    readOnly: true,
  });
  expect(backup.prepare("PRAGMA user_version").get()!.user_version).toBe(3);
  backup.close();
  await mkdir(resolve(__dirname, "../../.tmp/validation"), { recursive: true });
  await writeFile(
    resolve(__dirname, "../../.tmp/validation/binary-upgrade.json"),
    JSON.stringify(
      {
        oldVersion: "0.5.1",
        newVersion: "0.6.3",
        before,
        backupManifest: manifest,
        allOriginalColumnsEqual: true,
        installerExecution: false,
      },
      null,
      2,
    ),
  );
});
