import { useBusinessVersion } from "../data/invalidation";
import { useCallback, useEffect, useRef, useState } from "react";
import FullCalendar, {
  type CalendarRef,
  type EventDropInfo,
  type EventResizeDoneInfo,
} from "@fullcalendar/react";
import timeGrid from "@fullcalendar/react/timegrid";
import interaction from "@fullcalendar/react/interaction";
import monarch from "@fullcalendar/react/themes/monarch";
import zhCn from "@fullcalendar/react/locales/zh-cn";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/monarch/theme.css";
import type {
  Member,
  OccurrenceInput,
  OccurrenceView,
  RecordFilters,
} from "../../shared/contracts";
import {
  formatLocalDate,
  formatLocalTime,
  hoursLabel,
} from "../../domain/time";
import {
  AppButton,
  AppDialog,
  AppInput,
  AppSelect,
  AppTextarea,
  MemberCombobox,
  useFeedback,
} from "../ui";
import { useCommand } from "../data/commands";
import { registerNavigationGuard } from "../data/navigation";
import { errorMessage } from "../App";
import {
  ATTENDANCE_STATE_MARK,
  attendancePersonLabel,
  attendanceShiftVisualState,
  attendanceSlotVisualState,
} from "../../domain/attendance-visual";

const fromShift = (shift: OccurrenceView): OccurrenceInput => ({
  id: shift.id,
  operationId: crypto.randomUUID(),
  expectedRevision: shift.revision,
  date: shift.date,
  startTime: shift.startTime,
  endTime: shift.endTime,
  kind: shift.kind,
  workType: shift.workType,
  label: shift.label,
  note: shift.note,
  memberIds: shift.slots
    .map((s) => s.scheduledMemberId)
    .filter((id): id is string => Boolean(id)),
});
export function CalendarPage({
  members,
  onChanged,
  onOpenRecords,
}: {
  members: Member[];
  onChanged(): Promise<void>;
  onOpenRecords(filters: RecordFilters): void;
}) {
  const businessVersion = useBusinessVersion();
  const calendar = useRef<CalendarRef>(null);
  const [range, setRange] = useState({
    startDate: formatLocalDate(new Date()),
    endDate: formatLocalDate(new Date()),
  });
  const [title, setTitle] = useState("");
  const [view, setView] = useState("timeGridWeek");
  const [date, setDate] = useState(formatLocalDate(new Date()));
  const [shifts, setShifts] = useState<OccurrenceView[]>([]);
  const [now, setNow] = useState(new Date());
  const [cancelled, setCancelled] = useState(false);
  const [detail, setDetail] = useState<OccurrenceView | null>(null);
  const [editor, setEditor] = useState<OccurrenceInput | null>(null);
  const latestShifts = useRef(shifts);
  latestShifts.current = shifts;
  useEffect(() => {
    document
      .querySelectorAll<HTMLElement>("[data-occurrence-id]")
      .forEach((el) => {
        const shift = shifts.find((s) => s.id === el.dataset.occurrenceId);
        if (shift) {
          const label =
            shift.label +
            " · " +
            shift.slots
              .map(
                (slot) =>
                  `${ATTENDANCE_STATE_MARK[attendanceSlotVisualState(shift, slot, now)]} ${attendancePersonLabel(slot)}`,
              )
              .join("、") +
            " " +
            shift.date +
            " " +
            shift.startTime +
            "–" +
            shift.endTime;
          el.title = label;
          el.setAttribute("aria-label", label);
        }
      });
  }, [shifts, now]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const [height, setHeight] = useState(window.innerHeight);
  useEffect(() => {
    const resized = () => setHeight(window.innerHeight);
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, []);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  const { confirm } = useFeedback();
  const load = useCallback(async () => {
    const token = ++request.current;
    setLoading(true);
    try {
      const rows = await window.checkinApi.listOccurrences({
        ...range,
        includeCancelled: true,
      });
      if (token === request.current) {
        setShifts(rows);
        setDetail((old) =>
          old ? (rows.find((s) => s.id === old.id) ?? null) : null,
        );
        setLoadError("");
      }
    } catch (e) {
      if (token === request.current) setLoadError(errorMessage(e));
      throw e;
    } finally {
      if (token === request.current) setLoading(false);
    }
  }, [range.startDate, range.endDate]);
  useEffect(() => {
    void load().catch(() => undefined);
    return () => {
      request.current++;
    };
  }, [load, businessVersion]);
  const command = useCommand(async () => {
    await Promise.all([load(), onChanged()]);
  });
  const create = (day = date, start = "09:00", end = "10:00") =>
    setEditor({
      operationId: crypto.randomUUID(),
      date: day,
      startTime: start,
      endTime: end,
      kind: "desk",
      workType: "regular",
      label: "临时坐班",
      note: "",
      memberIds: [],
    });
  async function move(info: EventDropInfo | EventResizeDoneInfo) {
    const shift = shifts.find((s) => s.id === info.event.id);
    const start = info.event.start;
    const end = info.event.end;
    if (command.pending || !shift?.editable || !start || !end) {
      info.revert();
      return;
    }
    if (formatLocalDate(start) !== formatLocalDate(end)) {
      info.revert();
      command.setError("同一班次不能跨日；可移到另一天的同日时段。");
      return;
    }
    const approved = await confirm({
      title: "修改本次安排",
      message: `${shift.date} ${shift.startTime}–${shift.endTime} → ${formatLocalDate(start)} ${formatLocalTime(start)}–${formatLocalTime(end)}。${shift.slots.some((s) => s.leave) ? "关联请假的时间会一并变化。" : ""}确认后仅修改这一次安排。`,
      confirmLabel: "保存本次修改",
    });
    if (!approved) {
      info.revert();
      return;
    }
    const result = await command.run(
      () =>
        window.checkinApi.saveOccurrence({
          ...fromShift(shift),
          date: formatLocalDate(start),
          startTime: formatLocalTime(start),
          endTime: formatLocalTime(end),
          confirmImpact: true,
        }),
      "本次安排已更新",
    );
    if (!result) info.revert();
  }
  return (
    <div className="page-stack calendar-page">
      <div className="page-header">
        <div>
          <h1>日历排班</h1>
          <p>查看执行安排，编辑只影响所选的单次班次。</p>
        </div>
        <AppButton variant="primary" onClick={() => create()}>
          ＋ 新建班次
        </AppButton>
      </div>
      <div className="calendar-toolbar">
        <div className="button-row">
          <AppButton
            aria-label="上一周或日"
            onClick={() => calendar.current?.getApi().prev()}
          >
            ‹
          </AppButton>
          <AppButton onClick={() => calendar.current?.getApi().today()}>
            今天
          </AppButton>
          <AppButton
            aria-label="下一周或日"
            onClick={() => calendar.current?.getApi().next()}
          >
            ›
          </AppButton>
          <strong>{title}</strong>
        </div>
        <div className="button-row">
          <AppInput
            type="date"
            aria-label="跳转日期"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              if (e.target.value)
                calendar.current?.getApi().gotoDate(e.target.value);
            }}
          />
          <AppSelect
            aria-label="日历视图"
            value={view}
            onChange={(e) => {
              setView(e.target.value);
              calendar.current?.getApi().changeView(e.target.value);
            }}
          >
            <option value="timeGridWeek">七天视图</option>
            <option value="timeGridDay">日视图</option>
          </AppSelect>
        </div>
      </div>
      {(loadError || command.error) && (
        <div role="alert" className="inline-error">
          {loadError || command.error}
          <AppButton onClick={() => load().catch(() => undefined)}>
            重新加载
          </AppButton>
        </div>
      )}
      <div className="calendar-legend">
        <span className="attendance-complete">● 全部处理</span>
        <span className="attendance-attention">● 待签到</span>
        <span className="attendance-upcoming">● 未开始</span>
        <span className="attendance-leave">● 请假</span>
        <span className="calendar-hint">拖动吸附 15 分钟 · 表单可精确到分钟</span>
        <span role="status">
          {loading
            ? "正在加载…"
            : command.pending
              ? "正在保存…"
              : `${shifts.filter((s) => s.active).length} 个班次`}
        </span>
      </div>
      <section className="full-calendar" aria-label="排班日历">
        <FullCalendar
          ref={calendar}
          plugins={[timeGrid, interaction, monarch]}
          locale={zhCn}
          initialView="timeGridWeek"
          titleFormat={{ year: "numeric", month: "long", day: "numeric" }}
          firstDay={1}
          weekends
          headerToolbar={false}
          height={Math.max(320, height - 330)}
          allDaySlot={false}
          nowIndicator
          slotMinTime="00:00:00"
          slotMaxTime="24:00:00"
          scrollTime="08:00:00"
          slotDuration="00:30:00"
          snapDuration="00:15:00"
          eventMinHeight={0}
          eventShortHeight={24}
          slotEventOverlap={false}
          editable={!command.pending}
          selectable
          selectMirror
          datesSet={(info) => {
            const end = new Date(info.end);
            end.setDate(end.getDate() - 1);
            setRange({
              startDate: formatLocalDate(info.start),
              endDate: formatLocalDate(end),
            });
            setTitle(info.view.title);
            setDate(formatLocalDate(info.start));
          }}
          events={shifts
            .filter((s) => s.active)
            .map((s) => {
              const visualState = attendanceShiftVisualState(s, now);
              const people = s.slots
                .map((slot) => {
                  const state = attendanceSlotVisualState(s, slot, now);
                  return `${ATTENDANCE_STATE_MARK[state]}${attendancePersonLabel(slot)}`;
                })
                .join("、");
              return {
              id: s.id,
              title: `${s.workType === "overtime" ? "加班" : s.label} · ${people}`,
              start: s.date + "T" + s.startTime,
              end: s.date + "T" + s.endTime,
              editable: s.editable && !command.pending,
              className: [
                "occurrence-event",
                s.workType === "overtime" ? "overtime" : s.kind,
                `attendance-${visualState}`,
                !s.editable ? "locked" : "",
              ].join(" "),
              extendedProps: { shift: s },
              };
            })}
          eventClick={(info) => {
            const shift = shifts.find((s) => s.id === info.event.id);
            if (shift) setDetail(shift);
          }}
          eventDidMount={(info) => {
            info.el.dataset.occurrenceId = info.event.id;
            info.el.title =
              info.event.title +
              " " +
              info.event.startStr.slice(0, 16) +
              "–" +
              info.event.endStr.slice(11, 16);
            info.el.setAttribute("tabindex", "0");
            info.el.setAttribute(
              "aria-label",
              info.event.title + " " + info.event.startStr.slice(0, 16),
            );
            info.el.addEventListener("keydown", (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                const shift = latestShifts.current.find(
                  (s) => s.id === info.event.id,
                );
                if (shift) setDetail(shift);
              }
            });
          }}
          dateClick={(info) => {
            const start = info.date;
            const end = new Date(start.getTime() + 60 * 60 * 1000);
            if (formatLocalDate(start) === formatLocalDate(end))
              create(
                formatLocalDate(start),
                formatLocalTime(start),
                formatLocalTime(end),
              );
          }}
          select={(info) => {
            calendar.current?.getApi().unselect();
            if (formatLocalDate(info.start) !== formatLocalDate(info.end)) {
              command.setError("班次时间需在同一天。");
              return;
            }
            create(
              formatLocalDate(info.start),
              formatLocalTime(info.start),
              formatLocalTime(info.end),
            );
          }}
          eventDrop={(info) => {
            void move(info);
          }}
          eventResize={(info) => {
            void move(info);
          }}
        />
      </section>
      <AppButton variant="quiet" onClick={() => setCancelled(!cancelled)}>
        {cancelled ? "收起" : "查看"}已取消的班次（
        {shifts.filter((s) => !s.active).length}）
      </AppButton>
      {cancelled &&
        shifts
          .filter((s) => !s.active)
          .map((s) => (
            <div className="operation-row" key={s.id}>
              <span>
                {s.date} {s.startTime}–{s.endTime} · {s.label}
              </span>
              <AppButton onClick={() => setDetail(s)}>详情与恢复</AppButton>
            </div>
          ))}
      <AppDialog
        open={Boolean(detail)}
        title={detail?.label ?? "班次详情"}
        drawer
        onClose={() => setDetail(null)}
      >
        {detail && (
          <div className="page-stack">
            <div className="detail-time">
              {detail.date}
              <strong>
                {detail.startTime} – {detail.endTime}
              </strong>
              <span>
                {hoursLabel(detail.paidMinutes)} 小时 ·{" "}
                {detail.active ? "执行安排" : "已取消"}
              </span>
            </div>
            <p>
              {detail.origin === "imported" ? "来自正式排班" : "单次手动安排"}
              {detail.original &&
                ` · 原始 ${detail.original.date} ${detail.original.startTime}–${detail.original.endTime}`}
            </p>
            <p>{detail.note || "无备注"}</p>
            <div className="detail-people">
              {detail.slots.map((s) => (
                <div className="operation-row" key={s.id}>
                  <strong>{s.scheduledMemberName}</strong>
                  <span>
                    {s.attendanceId
                      ? `已签到 · ${s.actualMemberName}`
                      : s.leave
                        ? "已请假"
                        : "未签到"}
                  </span>
                </div>
              ))}
            </div>
            {!detail.editable && detail.active && (
              <p className="warning-banner">
                已有签到历史或班次已结束。请通过记录更正、撤销、恢复或补记处理考勤。
              </p>
            )}
            <div className="button-row">
              {detail.editable && (
                <AppButton
                  variant="primary"
                  onClick={() => {
                    setEditor(fromShift(detail));
                    setDetail(null);
                  }}
                >
                  编辑本次
                </AppButton>
              )}
              <AppButton
                onClick={() => {
                  const copied = fromShift(detail);
                  delete copied.id;
                  delete copied.expectedRevision;
                  copied.date = formatLocalDate(new Date());
                  setEditor(copied);
                  setDetail(null);
                }}
              >
                复制班次
              </AppButton>
              <AppButton
                onClick={() =>
                  onOpenRecords({
                    startDate: detail.date,
                    endDate: detail.date,
                    shiftId: detail.id,
                  })
                }
              >
                签到记录与补记
              </AppButton>
            </div>
            {detail.editable && (
              <AppButton
                variant="danger"
                disabled={command.pending}
                onClick={async () => {
                  if (
                    await confirm({
                      title: "取消本次班次",
                      message:
                        "本次安排会保留在已取消列表，可在没有后续冲突时恢复。",
                      confirmLabel: "取消班次",
                    })
                  ) {
                    const result = await command.run(
                      () =>
                        window.checkinApi.cancelOccurrence({
                          id: detail.id,
                          expectedRevision: detail.revision,
                          operationId: crypto.randomUUID(),
                        }),
                      "班次已取消",
                    );
                    if (result) setDetail(null);
                  }
                }}
              >
                取消本次班次
              </AppButton>
            )}
            {!detail.active && (
              <AppButton
                disabled={!detail.recoveryOperationId || command.pending}
                onClick={async () => {
                  const id = detail.recoveryOperationId;
                  if (id) {
                    const result = await command.run(
                      () => window.checkinApi.undoOperation(id),
                      "班次已恢复",
                    );
                    if (result) setDetail(null);
                  }
                }}
              >
                {detail.recoveryOperationId
                  ? "恢复本次班次"
                  : "存在后续变更，无法直接恢复"}
              </AppButton>
            )}
          </div>
        )}
      </AppDialog>
      {editor && (
        <OccurrenceEditor
          key={editor.operationId}
          initial={editor}
          members={members}
          onClose={() => setEditor(null)}
          onSave={async (input) => {
            const result = await command.run(
              () => window.checkinApi.saveOccurrence(input),
              "本次安排已保存",
            );
            return Boolean(result);
          }}
        />
      )}
    </div>
  );
}

function OccurrenceEditor({
  initial,
  members,
  onSave,
  onClose,
}: {
  initial: OccurrenceInput;
  members: Member[];
  onSave(value: OccurrenceInput): Promise<boolean>;
  onClose(): void;
}) {
  const [value, setValue] = useState(initial);
  const [person, setPerson] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const { confirm } = useFeedback();
  const dirty = JSON.stringify(value) !== JSON.stringify(initial);
  const canClose = useCallback(
    async () =>
      !saving &&
      (!dirty ||
        (await confirm({
          title: "放弃未保存的班次？",
          message: "当前输入尚未保存，关闭后会丢弃这些修改。",
          confirmLabel: "放弃修改",
          cancelLabel: "继续编辑",
        }))),
    [saving, dirty, confirm],
  );
  useEffect(() => registerNavigationGuard(canClose), [canClose]);
  async function save() {
    if (lock.current) return;
    if (
      !value.date ||
      !value.startTime ||
      !value.endTime ||
      value.endTime <= value.startTime ||
      !value.memberIds.length ||
      !value.label.trim()
    ) {
      setError("请填写名称、同日有效时段，并至少安排一位成员。");
      return;
    }
    let confirmImpact = false;
    if (
      value.id &&
      (value.date !== initial.date ||
        value.startTime !== initial.startTime ||
        value.endTime !== initial.endTime)
    ) {
      confirmImpact = await confirm({
        title: "确认时间变更",
        message:
          "只修改本次执行安排；进行中的班次和已关联请假的时间将随之变化。正式排班源保留原样。",
        confirmLabel: "保存变更",
      });
      if (!confirmImpact) return;
    }
    lock.current = true;
    setSaving(true);
    setError("");
    try {
      if (await onSave({ ...value, confirmImpact })) onClose();
      else setError("未能保存。请检查页面错误提示，当前输入已保留。");
    } finally {
      setSaving(false);
      lock.current = false;
    }
  }
  return (
    <AppDialog
      open
      title={value.id ? "编辑本次班次" : "新建班次"}
      drawer
      onClose={() => {
        void canClose().then((ok) => {
          if (ok) onClose();
        });
      }}
    >
      <div className="form-grid two">
        <label className="full-width">
          班次名称
          <AppInput
            aria-label="班次名称"
            value={value.label}
            onChange={(e) => setValue({ ...value, label: e.target.value })}
          />
        </label>
        <label>
          日期
          <AppInput
            type="date"
            aria-label="班次日期"
            value={value.date}
            onChange={(e) => setValue({ ...value, date: e.target.value })}
          />
        </label>
        <label>
          类型
          <AppSelect
            aria-label="班次类型"
            value={value.workType === "overtime" ? "overtime" : value.kind}
            disabled={Boolean(value.id)}
            onChange={(e) =>
              setValue({
                ...value,
                kind:
                  e.target.value === "overtime"
                    ? "desk"
                    : (e.target.value as OccurrenceInput["kind"]),
                workType:
                  e.target.value === "overtime" ? "overtime" : "regular",
              })
            }
          >
            <option value="desk">工作日坐班</option>
            <option value="maintenance">维修班</option>
            <option value="weekend">周末坐班</option>
            <option value="overtime">加班</option>
          </AppSelect>
        </label>
        <label>
          开始时间
          <AppInput
            type="time"
            aria-label="开始时间"
            value={value.startTime}
            onChange={(e) => setValue({ ...value, startTime: e.target.value })}
          />
        </label>
        <label>
          结束时间
          <AppInput
            type="time"
            aria-label="结束时间"
            value={value.endTime}
            onChange={(e) => setValue({ ...value, endTime: e.target.value })}
          />
        </label>
      </div>
      <h3>安排人员</h3>
      <div className="button-row">
        <MemberCombobox
          members={members}
          value={person}
          onChange={setPerson}
          excluded={value.memberIds}
          label="安排人员"
        />
        <AppButton
          disabled={!person}
          onClick={() => {
            setValue({ ...value, memberIds: [...value.memberIds, person] });
            setPerson("");
          }}
        >
          加入
        </AppButton>
      </div>
      <div className="person-tags">
        {value.memberIds.map((id) => (
          <span key={id}>
            {members.find((m) => m.id === id)?.name ?? "已停用成员"}
            <AppButton
              size="compact"
              variant="quiet"
              aria-label={`移除 ${members.find((m) => m.id === id)?.name}`}
              onClick={() =>
                setValue({
                  ...value,
                  memberIds: value.memberIds.filter((p) => p !== id),
                })
              }
            >
              ×
            </AppButton>
          </span>
        ))}
      </div>
      <label>
        备注
        <AppTextarea
          rows={3}
          value={value.note}
          onChange={(e) => setValue({ ...value, note: e.target.value })}
        />
      </label>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-footer">
        <AppButton variant="primary" pending={saving} onClick={save}>
          保存本次安排
        </AppButton>
        <AppButton
          disabled={saving}
          onClick={async () => {
            if (await canClose()) onClose();
          }}
        >
          取消
        </AppButton>
      </div>
    </AppDialog>
  );
}
