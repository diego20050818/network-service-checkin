import { useBusinessVersion } from "../data/invalidation";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AttendanceRecordView,
  Member,
  RecordFilters,
  ShiftView,
} from "../../shared/contracts";
import { formatLocalDate } from "../../domain/time";
import { EmptyState, Hours, StatusPill } from "../components";
import {
  RecordFiltersBar,
  resolvedFilters,
} from "../components/RecordFiltersBar";
import {
  AppButton,
  AppDialog,
  AppInput,
  AppSelect,
  MemberCombobox,
  useFeedback,
} from "../ui";
import { useCommand } from "../data/commands";
import { errorMessage } from "../App";

export function RecordsPage({
  members,
  onChanged,
  context,
  onContextChange,
}: {
  members: Member[];
  onChanged(): Promise<void>;
  context: RecordFilters;
  onContextChange(value: RecordFilters): void;
}) {
  const businessVersion = useBusinessVersion();
  const filters = resolvedFilters(context);
  const [records, setRecords] = useState<AttendanceRecordView[]>([]);
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<AttendanceRecordView | null>(null);
  const [manual, setManual] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const token = useRef(0);
  const load = useCallback(async () => {
    const request = ++token.current;
    setLoading(true);
    try {
      const result = await window.checkinApi.listRecords({
        ...filters,
        includeRevoked: true,
      });
      if (request === token.current) {
        setRecords(result);
        setDetail((old) =>
          old ? (result.find((r) => r.id === old.id) ?? null) : null,
        );
        setError("");
      }
    } catch (e) {
      if (request === token.current) setError(errorMessage(e));
      throw e;
    } finally {
      if (request === token.current) setLoading(false);
    }
  }, [
    filters.startDate,
    filters.endDate,
    filters.memberId,
    filters.kind,
    filters.shiftId,
  ]);
  useEffect(() => {
    setPage(1);
    void load().catch(() => undefined);
    return () => {
      token.current++;
    };
  }, [load, businessVersion]);
  async function refresh() {
    await Promise.all([load(), onChanged()]);
  }
  const pages = Math.max(1, Math.ceil(records.length / 50));
  const current = Math.min(page, pages);
  return (
    <div className="page-stack">
      <div className="page-header">
        <div>
          <h1>签到明细</h1>
          <p>更正和撤销影响当前统计；已经导出的文件保持原样。</p>
        </div>
        <AppButton onClick={() => setManual(true)}>＋ 补记签到</AppButton>
      </div>
      <RecordFiltersBar
        members={members}
        value={context}
        onChange={onContextChange}
      />
      {error && (
        <div className="inline-error" role="alert">
          {error}
          <AppButton onClick={() => load().catch(() => undefined)}>
            重新加载
          </AppButton>
        </div>
      )}
      <div className="card-title-row">
        <h2>记录明细</h2>
        <span role="status">
          {loading ? "正在加载…" : `共 ${records.length} 条 · 每页 50 条`}
        </span>
      </div>
      {!loading && !records.length ? (
        <EmptyState
          title="所选范围暂无记录"
          description="调整筛选范围，或补记已有班次的签到。"
        />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>日期与班次</th>
                <th>原排班</th>
                <th>实际人员</th>
                <th>打卡时间</th>
                <th>计薪</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {records.slice((current - 1) * 50, current * 50).map((r) => (
                <tr
                  key={r.id}
                  className={r.status === "revoked" ? "muted-row" : ""}
                >
                  <td>
                    <strong>{r.date}</strong>
                    <small>
                      {r.label} · {r.startTime}–{r.endTime}
                    </small>
                  </td>
                  <td>{r.scheduledMemberName ?? "空位"}</td>
                  <td>
                    <strong>{r.actualMemberName}</strong>
                  </td>
                  <td>
                    {r.punchTime
                      ? new Date(r.punchTime).toLocaleString("zh-CN", {
                          hour12: false,
                        })
                      : "补记未填写"}
                  </td>
                  <td>
                    <Hours minutes={r.paidMinutes} />
                  </td>
                  <td>
                    <RecordStatus record={r} />
                  </td>
                  <td>
                    <AppButton
                      variant="quiet"
                      size="compact"
                      onClick={() => setDetail(r)}
                    >
                      详情与改错
                    </AppButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pagination">
        <span>
          {records.length
            ? `${(current - 1) * 50 + 1}–${Math.min(current * 50, records.length)} / ${records.length}`
            : "0 条"}
        </span>
        <AppButton disabled={current <= 1} onClick={() => setPage(current - 1)}>
          上一页
        </AppButton>
        <span>
          第 {current} / {pages} 页
        </span>
        <AppButton
          disabled={current >= pages}
          onClick={() => setPage(current + 1)}
        >
          下一页
        </AppButton>
      </div>
      {detail && (
        <RecordDetail
          key={detail.id + "-" + detail.actualMemberId + "-" + detail.status}
          record={detail}
          members={members}
          refresh={refresh}
          onClose={() => setDetail(null)}
        />
      )}
      {manual && (
        <ManualEntry
          members={members}
          initialDate={filters.startDate}
          shiftId={filters.shiftId}
          refresh={refresh}
          onClose={() => setManual(false)}
        />
      )}
    </div>
  );
}
export function RecordStatus({ record: r }: { record: AttendanceRecordView }) {
  return (
    <StatusPill
      tone={
        r.status === "revoked"
          ? "gray"
          : r.lateStatus === "late"
            ? "amber"
            : "green"
      }
    >
      {r.status === "revoked"
        ? "已撤销"
        : r.workType === "overtime"
          ? "加班"
          : r.lateStatus === "late"
            ? "迟到"
            : r.lateStatus === "manual_unjudged"
              ? "补记未判定"
              : "已签到"}
    </StatusPill>
  );
}
export function RecordDetail({
  record,
  members,
  refresh,
  onClose,
}: {
  record: AttendanceRecordView;
  members: Member[];
  refresh(): Promise<void>;
  onClose(): void;
}) {
  const [memberId, setMemberId] = useState(record.actualMemberId);
  const command = useCommand(refresh);
  const { confirm } = useFeedback();
  return (
    <AppDialog
      open
      title="签到详情与改错"
      drawer
      onClose={() => {
        if (!command.pending) onClose();
      }}
    >
      <div className="page-stack">
        <div className="detail-time">
          {record.date}
          <strong>
            {record.label} · {record.startTime} – {record.endTime}
          </strong>
          <RecordStatus record={record} />
        </div>
        <dl className="detail-list">
          <dt>原排班</dt>
          <dd>{record.scheduledMemberName ?? "空位"}</dd>
          <dt>实际人员</dt>
          <dd>{record.actualMemberName}</dd>
          <dt>打卡时间</dt>
          <dd>
            {record.punchTime
              ? new Date(record.punchTime).toLocaleString("zh-CN")
              : "人工补记，未填写历史时刻"}
          </dd>
          <dt>计薪工时</dt>
          <dd>
            <Hours minutes={record.paidMinutes} />
          </dd>
          <dt>录入时间</dt>
          <dd>{new Date(record.enteredAt).toLocaleString("zh-CN")}</dd>
        </dl>
        {record.status === "active" && (
          <label>
            更正实际人员
            <MemberCombobox
              members={members}
              value={memberId}
              onChange={setMemberId}
              label="更正实际人员"
              disabled={command.pending}
            />
          </label>
        )}
        {command.error && (
          <div role="alert" className="inline-error">
            {command.error}
          </div>
        )}
        <div className="button-row">
          {record.status === "active" ? (
            <>
              <AppButton
                variant="primary"
                disabled={
                  command.pending ||
                  !memberId ||
                  memberId === record.actualMemberId
                }
                onClick={async () => {
                  if (
                    await command.run(
                      () =>
                        window.checkinApi.attendanceAction({
                          type: "correct",
                          operationId: crypto.randomUUID(),
                          shiftId: record.shiftId,
                          recordId: record.id,
                          memberId,
                        }),
                      "实际人员已更正",
                    )
                  )
                    onClose();
                }}
              >
                保存更正
              </AppButton>
              <AppButton
                variant="danger"
                disabled={command.pending}
                onClick={async () => {
                  if (
                    await confirm({
                      title: "撤销这条签到？",
                      message: "撤销后不计入工时，可在详情中恢复。",
                      confirmLabel: "撤销签到",
                    })
                  ) {
                    if (
                      await command.run(
                        () =>
                          window.checkinApi.attendanceAction({
                            type: "revoke",
                            operationId: crypto.randomUUID(),
                            shiftId: record.shiftId,
                            recordId: record.id,
                          }),
                        "签到已撤销",
                      )
                    )
                      onClose();
                  }
                }}
              >
                撤销签到
              </AppButton>
            </>
          ) : (
            <AppButton
              variant="primary"
              disabled={command.pending}
              onClick={async () => {
                if (
                  await command.run(
                    () =>
                      window.checkinApi.attendanceAction({
                        type: "restore",
                        operationId: crypto.randomUUID(),
                        shiftId: record.shiftId,
                        recordId: record.id,
                      }),
                    "签到已恢复",
                  )
                )
                  onClose();
              }}
            >
              恢复签到及原临时席位
            </AppButton>
          )}
        </div>
      </div>
    </AppDialog>
  );
}
export function ManualEntry({
  members,
  initialDate,
  shiftId,
  refresh,
  onClose,
}: {
  members: Member[];
  initialDate?: string;
  shiftId?: string;
  refresh(): Promise<void>;
  onClose(): void;
}) {
  const [date, setDate] = useState(initialDate ?? formatLocalDate(new Date()));
  const [shifts, setShifts] = useState<ShiftView[]>([]);
  const [slotId, setSlotId] = useState("");
  const [memberId, setMemberId] = useState("");
  const [punchTime, setPunchTime] = useState("");
  const [error, setError] = useState("");
  const command = useCommand(refresh);
  const [operationId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let active = true;
    setShifts([]);
    setSlotId("");
    void window.checkinApi
      .getShiftsForDate(date)
      .then((rows) => {
        if (active) {
          setShifts(rows.filter((s) => !shiftId || s.id === shiftId));
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [date, shiftId]);
  const slots = shifts.flatMap((shift) =>
    shift.slots
      .filter(
        (slot) =>
          !slot.attendanceId &&
          !(slot.leave && !slot.leave.replacementMemberId),
      )
      .map((slot) => ({ shift, slot })),
  );
  return (
    <AppDialog
      open
      title="补记签到"
      drawer
      onClose={() => {
        if (!command.pending) onClose();
      }}
    >
      <p>
        只关联已有班次。未填历史打卡时刻时，迟到状态保持“人工补记／未判定”。
      </p>
      <div className="form-grid">
        <label>
          班次日期
          <AppInput
            type="date"
            aria-label="补记日期"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          班次席位
          <AppSelect
            searchable={false}
            aria-label="补记席位"
            value={slotId}
            onChange={(e) => {
              setSlotId(e.target.value);
              const slot = slots.find(
                (s) => s.slot.id === e.target.value,
              )?.slot;
              setMemberId(
                slot?.leave?.replacementMemberId ??
                  slot?.scheduledMemberId ??
                  "",
              );
            }}
          >
            <option value="">选择未签到席位</option>
            {slots.map(({ shift, slot }) => (
              <option key={slot.id} value={slot.id}>
                {shift.startTime}–{shift.endTime} {shift.label} ·{" "}
                {slot.scheduledMemberName ?? "空位"}
              </option>
            ))}
          </AppSelect>
        </label>
        <label>
          实际人员
          <MemberCombobox
            members={members}
            value={memberId}
            onChange={setMemberId}
            label="补记实际人员"
          />
        </label>
        <label>
          历史打卡时刻（可留空）
          <AppInput
            type="datetime-local"
            aria-label="历史打卡时刻"
            value={punchTime}
            onChange={(e) => setPunchTime(e.target.value)}
          />
        </label>
      </div>
      {(error || command.error) && (
        <div className="inline-error" role="alert">
          {error || command.error}
        </div>
      )}
      <div className="dialog-footer">
        <AppButton
          variant="primary"
          disabled={!slotId || !memberId}
          pending={command.pending}
          onClick={async () => {
            const shift = slots.find((s) => s.slot.id === slotId)?.shift;
            if (!shift) return;
            const result = await command.run(
              () =>
                window.checkinApi.attendanceAction({
                  type: "manual",
                  shiftId: shift.id,
                  operationId,
                  slotId,
                  memberId,
                  historicalPunchTime: punchTime
                    ? new Date(punchTime).toISOString()
                    : null,
                }),
              "人工补记已保存",
            );
            if (result) onClose();
          }}
        >
          保存补记
        </AppButton>
      </div>
    </AppDialog>
  );
}
