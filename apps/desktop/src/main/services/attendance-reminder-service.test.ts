import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseStore } from "../database";
import { AttendanceService } from "./attendance-service";
import { MemberService } from "./member-service";
import {
  AttendanceReminderService,
  deliverAttendanceReminder,
  type AttendanceReminderDeliveryTarget,
} from "./attendance-reminder-service";
import { addScheduleImport, addShift } from "./test-helpers.test-util";
import type { AttendanceReminderPayload } from "../../shared/contracts";

describe("AttendanceReminderService", () => {
  let store: DatabaseStore;
  let members: MemberService;
  let attendance: AttendanceService;

  beforeEach(() => {
    store = new DatabaseStore(":memory:");
    members = new MemberService(store);
    attendance = new AttendanceService(store, members);
  });
  afterEach(() => store.close());

  it("14:59 不提醒、15:00 提醒且重启后同一班不重复", () => {
    const importId = addScheduleImport(store);
    const shift = addShift(store, members, {
      importId,
      date: "2026-09-09",
      kind: "desk",
      startTime: "10:00",
      endTime: "11:00",
      paidMinutes: 60,
      people: ["甲"],
    });
    const emitted: AttendanceReminderPayload[] = [];
    const service = new AttendanceReminderService(store, attendance, (payload) =>
      emitted.push(payload),
    );

    expect(service.check(new Date(2026, 8, 9, 10, 14, 59))).toBeNull();
    expect(service.check(new Date(2026, 8, 9, 10, 15, 0))).toMatchObject({
      totalPending: 1,
      shifts: [{ id: shift.shiftId, pendingNames: ["甲"] }],
    });
    expect(service.check(new Date(2026, 8, 9, 10, 20, 0))).toBeNull();
    const restarted = new AttendanceReminderService(
      store,
      attendance,
      (payload) => emitted.push(payload),
    );
    expect(restarted.check(new Date(2026, 8, 9, 10, 25, 0))).toBeNull();
    expect(emitted).toHaveLength(1);
  });

  it("排除已签到、全部请假和已结束班次，并合并同时超时班次", () => {
    const importId = addScheduleImport(store);
    const mixed = addShift(store, members, {
      importId,
      date: "2026-09-09",
      kind: "desk",
      startTime: "10:00",
      endTime: "11:00",
      paidMinutes: 60,
      people: ["甲", "乙"],
    });
    const handled = addShift(store, members, {
      importId,
      date: "2026-09-09",
      kind: "desk",
      startTime: "10:01",
      endTime: "11:01",
      paidMinutes: 60,
      people: ["丙"],
    });
    const allLeave = addShift(store, members, {
      importId,
      date: "2026-09-09",
      kind: "maintenance",
      startTime: "10:02",
      endTime: "11:02",
      paidMinutes: 60,
      people: ["丁"],
    });
    addShift(store, members, {
      importId,
      date: "2026-09-09",
      kind: "desk",
      startTime: "09:00",
      endTime: "10:00",
      paidMinutes: 60,
      people: ["戊"],
    });
    const another = addShift(store, members, {
      importId,
      date: "2026-09-09",
      kind: "maintenance",
      startTime: "10:03",
      endTime: "11:03",
      paidMinutes: 60,
      people: ["己", "庚"],
    });
    insertLeave(store, "leave-mixed", mixed.slotIds[0]!, mixed.memberIds.甲!);
    insertLeave(
      store,
      "leave-all",
      allLeave.slotIds[0]!,
      allLeave.memberIds.丁!,
    );
    attendance.addManual({
      slotId: handled.slotIds[0]!,
      memberId: handled.memberIds.丙!,
    });
    const service = new AttendanceReminderService(store, attendance, () => {});

    expect(service.check(new Date(2026, 8, 9, 10, 18, 0))).toMatchObject({
      totalPending: 3,
      shifts: [
        { id: mixed.shiftId, pendingNames: ["乙"] },
        { id: another.shiftId, pendingNames: ["己", "庚"] },
      ],
    });
  });

  it("定期清理超过七天的提醒去重记录", () => {
    store
      .prepare(
        "INSERT INTO settings(key,value_json,updated_at) VALUES('attendance_reminders',?,?)",
      )
      .run(
        JSON.stringify({
          version: 1,
          reminded: {
            old: "2026-08-01T00:00:00.000Z",
            recent: "2026-09-08T00:00:00.000Z",
          },
        }),
        "2026-09-08T00:00:00.000Z",
      );
    const service = new AttendanceReminderService(store, attendance, () => {});
    service.check(new Date("2026-09-09T10:00:00.000Z"));
    const row = store
      .prepare(
        "SELECT value_json FROM settings WHERE key='attendance_reminders'",
      )
      .get() as { value_json: string };
    expect(JSON.parse(row.value_json).reminded).toEqual({
      recent: "2026-09-08T00:00:00.000Z",
    });
  });
});

describe("deliverAttendanceReminder", () => {
  const payload: AttendanceReminderPayload = {
    triggeredAt: "2026-09-09T10:15:00.000+08:00",
    totalPending: 2,
    shifts: [
      {
        id: "shift-1",
        date: "2026-09-09",
        label: "维修班",
        startTime: "10:00",
        endTime: "11:00",
        pendingNames: ["甲", "乙"],
      },
    ],
  };

  it("后台发送系统通知、闪烁任务栏，点击通知恢复窗口", () => {
    let click: (() => void) | undefined;
    const target: AttendanceReminderDeliveryTarget = {
      send: vi.fn(),
      isForeground: () => false,
      showSystemNotification: vi.fn((_title, _body, onClick) => {
        click = onClick;
      }),
      flashTaskbar: vi.fn(),
      restoreWindow: vi.fn(),
    };
    deliverAttendanceReminder(payload, target);
    expect(target.send).toHaveBeenCalledWith(payload);
    expect(target.showSystemNotification).toHaveBeenCalledWith(
      "2 人尚未签到",
      "维修班：甲、乙",
      expect.any(Function),
    );
    expect(target.flashTaskbar).toHaveBeenCalledOnce();
    click?.();
    expect(target.restoreWindow).toHaveBeenCalledOnce();
  });

  it("前台只发送应用内提醒，不创建额外系统通知", () => {
    const target: AttendanceReminderDeliveryTarget = {
      send: vi.fn(),
      isForeground: () => true,
      showSystemNotification: vi.fn(),
      flashTaskbar: vi.fn(),
      restoreWindow: vi.fn(),
    };
    deliverAttendanceReminder(payload, target);
    expect(target.send).toHaveBeenCalledWith(payload);
    expect(target.showSystemNotification).not.toHaveBeenCalled();
    expect(target.flashTaskbar).not.toHaveBeenCalled();
  });
});

function insertLeave(
  store: DatabaseStore,
  id: string,
  slotId: string,
  memberId: string,
) {
  store
    .prepare(`
      INSERT INTO leave_records(
        id,shift_slot_id,member_id,reason,status,created_at,updated_at
      ) VALUES(?,?,?,'测试','active',?,?)
    `)
    .run(
      id,
      slotId,
      memberId,
      "2026-09-09T01:00:00.000Z",
      "2026-09-09T01:00:00.000Z",
    );
}
