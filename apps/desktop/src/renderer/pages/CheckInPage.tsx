import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AttendanceAction,
  AttendanceRecordView,
  BootstrapData,
  Member,
  OccurrenceView,
  ShiftSlotView,
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
  MemberCombobox,
  ActionMenu,
  useFeedback,
} from "../ui";
import { EmptyState } from "../components";
import { useCommand } from "../data/commands";
import { errorMessage } from "../App";
import { ManualEntry, RecordDetail } from "./RecordsPage";

export function CheckInPage({
  data,
  onChanged,
  onOpenData,
  onOpenRecords,
}: {
  data: BootstrapData;
  onChanged(): Promise<void>;
  onOpenData(): void;
  onOpenRecords(): void;
}) {
  const [now, setNow] = useState(new Date());
  const [shifts, setShifts] = useState<OccurrenceView[]>([]);
  const [records, setRecords] = useState<AttendanceRecordView[]>([]);
  const [error, setError] = useState("");
  const date = formatLocalDate(now);
  const token = useRef(0);
  const load = useCallback(async () => {
    const request = ++token.current;
    try {
      const [rows, entries] = await Promise.all([
        window.checkinApi.listOccurrences({ startDate: date, endDate: date }),
        window.checkinApi.listRecords({
          startDate: date,
          endDate: date,
          includeRevoked: true,
        }),
      ]);
      if (request === token.current) {
        setShifts(rows);
        setRecords(entries);
        setError("");
      }
    } catch (e) {
      if (request === token.current) setError(errorMessage(e));
      throw e;
    }
  }, [date]);
  useEffect(() => {
    void load().catch(() => undefined);
    return () => {
      token.current++;
    };
  }, [load, data]);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const refresh = useCallback(async () => {
    await Promise.all([load(), onChanged()]);
  }, [load, onChanged]);
  const completed = records.filter((r) => r.status === "active").length;
  return (
    <div className="page-stack checkin-page">
      <div className="page-header">
        <div>
          <div className="eyebrow">
            {now.toLocaleDateString("zh-CN", {
              month: "long",
              day: "numeric",
              weekday: "long",
            })}
          </div>
          <h1>今日签到</h1>
          <p>
            {shifts.length} 个班次 · 已签到 {completed} 人次
          </p>
        </div>
        <div className="today-clock">
          <strong>{formatLocalTime(now)}</strong>
          <AppButton variant="quiet" onClick={onOpenRecords}>
            今日记录 →
          </AppButton>
        </div>
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
          <AppButton onClick={() => load().catch(() => undefined)}>
            重新加载
          </AppButton>
        </div>
      )}
      {shifts.length ? (
        <section className="day-agenda">
          {shifts.map((shift) => (
            <ShiftAgenda
              key={shift.id}
              shift={shift}
              members={data.members}
              records={records.filter((r) => r.shiftId === shift.id)}
              now={now}
              refresh={refresh}
            />
          ))}
        </section>
      ) : (
        <EmptyState
          title="今天没有排班"
          description="导入正式排班后，这里会显示当天班次；也可在日历中添加单次安排。"
          action={
            <AppButton variant="primary" onClick={onOpenData}>
              导入排班
            </AppButton>
          }
        />
      )}
    </div>
  );
}
function defaultMember(slot: ShiftSlotView) {
  return slot.leave?.replacementMemberId ?? slot.scheduledMemberId ?? "";
}
function ShiftAgenda({
  shift,
  members,
  records,
  now,
  refresh,
}: {
  shift: OccurrenceView;
  members: Member[];
  records: AttendanceRecordView[];
  now: Date;
  refresh(): Promise<void>;
}) {
  const time = formatLocalTime(now);
  const phase =
    time < shift.startTime
      ? "upcoming"
      : time < shift.endTime
        ? "current"
        : "ended";
  const [open, setOpen] = useState(phase === "current");
  const [selection, setSelection] = useState<
    Record<string, { enabled: boolean; memberId: string; baseline: string }>
  >({});
  const [adding, setAdding] = useState(false);
  const [staff, setStaff] = useState("");
  const [changing, setChanging] = useState<string | null>(null);
  const [detail, setDetail] = useState<AttendanceRecordView | null>(null);
  const [history, setHistory] = useState(false);
  const [manual, setManual] = useState(false);
  const { confirm } = useFeedback();
  const command = useCommand(refresh);
  useEffect(() => {
    if (phase === "current") setOpen(true);
  }, [phase]);
  useEffect(() => {
    setSelection((old) =>
      Object.fromEntries(
        shift.slots
          .filter(
            (s) =>
              !s.attendanceId && !(s.leave && !s.leave.replacementMemberId),
          )
          .map((s) => {
            const baseline = defaultMember(s) + ":" + (s.leave?.id ?? "");
            return [
              s.id,
              old[s.id]?.baseline === baseline
                ? old[s.id]!
                : { enabled: false, memberId: defaultMember(s), baseline },
            ];
          }),
      ),
    );
  }, [shift.revision]);
  const pending = shift.slots.filter(
    (s) => !s.attendanceId && !(s.leave && !s.leave.replacementMemberId),
  );
  const selected = useMemo(
    () =>
      pending
        .filter((s) => selection[s.id]?.enabled && selection[s.id]?.memberId)
        .map((s) => ({ slotId: s.id, memberId: selection[s.id]!.memberId })),
    [shift.revision, selection],
  );
  const signed = shift.slots.filter((s) => s.attendanceId).length;
  const exempt = shift.slots.filter(
    (s) => s.leave && !s.leave.replacementMemberId && !s.attendanceId,
  ).length;
  const occupied = shift.slots
    .flatMap((s) => [
      s.scheduledMemberId,
      s.leave?.replacementMemberId,
      s.actualMemberId,
    ])
    .filter((x): x is string => Boolean(x));
  async function action(
    input:
      | Omit<AttendanceAction, "operationId" | "shiftId">
      | Record<string, unknown>,
    label: string,
  ) {
    return command.run(
      () =>
        window.checkinApi.attendanceAction({
          ...input,
          operationId: crypto.randomUUID(),
          shiftId: shift.id,
          expectedRevision: shift.revision,
        } as AttendanceAction),
      label,
    );
  }
  async function remove(slot: ShiftSlotView) {
    if (slot.attendanceId) {
      if (
        !(await confirm({
          title: "撤销签到并移除临时席位？",
          message: "两项操作会一起保存。可以从最近操作恢复原席位及签到。",
          confirmLabel: "撤销并移除",
        }))
      )
        return;
      await action(
        {
          type: "revokeAndRemove",
          slotId: slot.id,
          recordId: slot.attendanceId,
        },
        "已撤销签到并移除席位",
      );
    } else
      await action({ type: "removeStaff", slotId: slot.id }, "临时席位已移除");
  }
  return (
    <section className={`agenda-row ${phase}`}>
      <div className="agenda-time">
        <strong>{shift.startTime}</strong>
        <span>{shift.endTime}</span>
        <small>{hoursLabel(shift.paidMinutes)}h</small>
      </div>
      <div className="agenda-content">
        <div className="agenda-heading">
          <AppButton
            variant="quiet"
            className="agenda-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <span aria-hidden="true">{open ? "⌄" : "›"}</span>
            <h2>{shift.workType === "overtime" ? "加班" : shift.label}</h2>
            <span className={`state-label ${phase}`}>
              {signed + exempt === shift.slots.length
                ? "已处理"
                : phase === "current"
                  ? "进行中"
                  : phase === "upcoming"
                    ? "未开始"
                    : "已结束"}
            </span>
          </AppButton>
          <span>
            {signed} 已签到{exempt > 0 ? ` · ${exempt} 请假` : ""} /{" "}
            {shift.slots.length} 人
          </span>
        </div>
        {!open && (
          <p className="agenda-summary">
            {shift.slots.map((s) => s.scheduledMemberName ?? "空位").join("、")}
            <AppButton
              variant="quiet"
              size="compact"
              onClick={() => setOpen(true)}
            >
              展开查看
            </AppButton>
          </p>
        )}
        {open && (
          <>
            {shift.note && <p>{shift.note}</p>}
            <div className="attendance-people">
              {shift.slots.map((slot) => {
                const already = Boolean(slot.attendanceId);
                const exempt = Boolean(
                  slot.leave && !slot.leave.replacementMemberId,
                );
                const state = selection[slot.id] ?? {
                  enabled: false,
                  memberId: defaultMember(slot),
                  baseline: "",
                };
                return (
                  <div
                    className={`attendance-person ${already ? "signed" : ""}`}
                    key={slot.id}
                  >
                    {already ? (
                      <span className="signed-mark" aria-label="已签到">
                        ✓
                      </span>
                    ) : exempt ? (
                      <span className="exempt-mark" aria-label="请假豁免">
                        —
                      </span>
                    ) : (
                      <AppInput
                        type="checkbox"
                        aria-label={`选择 ${slot.scheduledMemberName ?? "空位"} 签到`}
                        checked={state.enabled}
                        disabled={phase !== "current" || command.pending}
                        onChange={(e) =>
                          setSelection({
                            ...selection,
                            [slot.id]: { ...state, enabled: e.target.checked },
                          })
                        }
                      />
                    )}
                    <div className="person-label">
                      <strong>
                        {already
                          ? slot.actualMemberName
                          : (members.find((m) => m.id === state.memberId)
                              ?.name ??
                            slot.scheduledMemberName ??
                            "待选人员")}
                      </strong>
                      <small>
                        {slot.role === "responsible"
                          ? "负责人"
                          : slot.role === "overtime"
                            ? "加班人员"
                            : "办公人员"}
                        {slot.scheduledMemberName &&
                          ` · 原排班 ${slot.scheduledMemberName}`}
                        {slot.leave?.replacementMemberName &&
                          ` · 代班 ${slot.leave.replacementMemberName}`}
                      </small>
                    </div>
                    <span
                      className={
                        already
                          ? "success-text"
                          : exempt
                            ? "muted-value"
                            : phase === "ended"
                              ? "danger-text"
                              : "muted-value"
                      }
                    >
                      {already
                        ? `已签到 ${slot.punchTime ? new Date(slot.punchTime).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : ""}`
                        : exempt
                          ? "请假豁免"
                          : phase === "ended"
                            ? "未到岗"
                            : phase === "current"
                              ? "待签到"
                              : "等待开班"}
                    </span>
                    <ActionMenu
                      label={`${slot.scheduledMemberName ?? "席位"}的操作`}
                      items={[
                        ...(already
                          ? [
                              {
                                id: "detail",
                                label: "更正或撤销签到",
                                action: () => {
                                  const r = records.find(
                                    (r) => r.id === slot.attendanceId,
                                  );
                                  if (r) setDetail(r);
                                },
                              },
                            ]
                          : !exempt
                            ? [
                                {
                                  id: "change",
                                  label: "选择实际到场人员",
                                  disabled: phase !== "current",
                                  action: () => setChanging(slot.id),
                                },
                              ]
                            : []),
                        ...(slot.source === "manual" && slot.role === "staff"
                          ? [
                              {
                                id: "remove",
                                label: already
                                  ? "撤销签到并移除"
                                  : "移除临时席位",
                                disabled: command.pending,
                                danger: true,
                                action: () => {
                                  void remove(slot);
                                },
                              },
                            ]
                          : []),
                      ]}
                    />
                  </div>
                );
              })}
            </div>
            {command.error && (
              <div className="inline-error" role="alert">
                {command.error}
              </div>
            )}
            <div className="agenda-actions">
              <div className="button-row">
                {shift.workType === "regular" && (
                  <AppButton
                    variant="quiet"
                    disabled={command.pending}
                    onClick={() => setAdding(!adding)}
                  >
                    ＋ 添加办公人员
                  </AppButton>
                )}
                <AppButton variant="quiet" onClick={() => setHistory(true)}>
                  已撤销与已移除（
                  {records.filter((r) => r.status === "revoked").length +
                    shift.removedSlots.length}
                  ）
                </AppButton>
                {phase !== "current" && (
                  <AppButton variant="quiet" onClick={() => setManual(true)}>
                    补记
                  </AppButton>
                )}
              </div>
              {phase === "current" && (
                <div className="button-row">
                  <AppButton
                    variant="quiet"
                    disabled={command.pending || !pending.length}
                    onClick={() =>
                      setSelection(
                        Object.fromEntries(
                          pending.map((s) => [
                            s.id,
                            {
                              ...(selection[s.id] ?? {
                                memberId: defaultMember(s),
                                baseline:
                                  defaultMember(s) + ":" + (s.leave?.id ?? ""),
                              }),
                              enabled: true,
                            },
                          ]),
                        ),
                      )
                    }
                  >
                    选择全部待签到
                  </AppButton>
                  <AppButton
                    variant="primary"
                    disabled={!selected.length}
                    pending={command.pending}
                    onClick={async () => {
                      const result = await action(
                        { type: "checkin", selections: selected },
                        `已提交 ${selected.length} 人签到`,
                      );
                      if (result) setSelection({});
                    }}
                  >
                    为所选 {selected.length} 人签到
                  </AppButton>
                </div>
              )}
            </div>
            {adding && (
              <div className="inline-editor">
                <MemberCombobox
                  members={members}
                  value={staff}
                  onChange={setStaff}
                  excluded={occupied}
                  label="添加办公人员"
                />
                <AppButton
                  disabled={!staff || command.pending}
                  onClick={async () => {
                    if (
                      await action(
                        { type: "addStaff", memberId: staff },
                        "办公人员已加入本班",
                      )
                    ) {
                      setStaff("");
                      setAdding(false);
                    }
                  }}
                >
                  加入本班
                </AppButton>
                <AppButton variant="quiet" onClick={() => setAdding(false)}>
                  取消
                </AppButton>
              </div>
            )}
          </>
        )}
      </div>
      <AppDialog
        open={Boolean(changing)}
        title="选择实际到场人员"
        onClose={() => setChanging(null)}
      >
        {changing && (
          <>
            <MemberCombobox
              members={members}
              value={selection[changing]?.memberId ?? ""}
              onChange={(memberId) => {
                const current = selection[changing];
                if (current)
                  setSelection({
                    ...selection,
                    [changing]: { ...current, memberId },
                  });
              }}
              label="实际到场人员"
            />
            <div className="dialog-footer">
              <AppButton
                variant="primary"
                disabled={!selection[changing]?.memberId}
                onClick={() => setChanging(null)}
              >
                完成选择
              </AppButton>
            </div>
            <p>选择后仍需勾选并提交签到。</p>
          </>
        )}
      </AppDialog>
      <AppDialog
        open={history}
        title="已撤销与已移除"
        drawer
        onClose={() => setHistory(false)}
      >
        <p>恢复沿用原记录和席位；同班已有同一人员时会阻止重复。</p>
        {shift.removedSlots.map((slot) => (
          <div className="operation-row" key={slot.id}>
            <span>{slot.memberName} · 临时席位</span>
            <AppButton
              disabled={command.pending}
              onClick={() =>
                action(
                  { type: "restoreStaff", slotId: slot.id },
                  "原临时席位已恢复",
                )
              }
            >
              恢复席位
            </AppButton>
          </div>
        ))}
        {records
          .filter((r) => r.status === "revoked")
          .map((r) => (
            <div className="operation-row" key={r.id}>
              <span>{r.actualMemberName} · 已撤销签到</span>
              <AppButton
                onClick={() => {
                  setDetail(r);
                  setHistory(false);
                }}
              >
                详情与恢复
              </AppButton>
            </div>
          ))}
        {command.error && (
          <div className="inline-error" role="alert">
            {command.error}
          </div>
        )}
      </AppDialog>
      {detail && (
        <RecordDetail
          key={detail.id}
          record={detail}
          members={members}
          refresh={refresh}
          onClose={() => setDetail(null)}
        />
      )}
      {manual && (
        <ManualEntry
          initialDate={shift.date}
          shiftId={shift.id}
          members={members}
          refresh={refresh}
          onClose={() => setManual(false)}
        />
      )}
    </section>
  );
}
