import { useBusinessVersion } from "../data/invalidation";
import { useEffect, useState } from "react";
import type {
  DashboardSnapshot,
  Member,
  RecordFilters,
} from "../../shared/contracts";
import { EmptyState, Hours, StatusPill } from "../components";
import {
  RecordFiltersBar,
  resolvedFilters,
} from "../components/RecordFiltersBar";
import { AppButton } from "../ui";
import { errorMessage } from "../App";
export function DashboardPage({
  members,
  context,
  onContextChange,
  onOpenRecords,
}: {
  members: Member[];
  context: RecordFilters;
  onContextChange(value: RecordFilters): void;
  onOpenRecords(value: RecordFilters): void;
}) {
  const businessVersion = useBusinessVersion();
  const filters = resolvedFilters(context);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void window.checkinApi
      .getDashboard(filters)
      .then((value) => {
        if (active) {
          setSnapshot(value);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    filters.startDate,
    filters.endDate,
    filters.memberId,
    filters.kind,
    businessVersion,
  ]);
  return (
    <div className="page-stack">
      <div className="page-header">
        <div>
          <h1>工时汇总</h1>
          <p>汇总和明细共用日期、人员及班次筛选。</p>
        </div>
        <AppButton onClick={() => onOpenRecords(filters)}>
          查看签到明细
        </AppButton>
      </div>
      <RecordFiltersBar
        members={members}
        value={context}
        onChange={onContextChange}
      />
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {loading && <p role="status">正在汇总…</p>}
      {!loading && snapshot && (
        <>
          {" "}
          <section className="metric-grid">
            <div className="metric-cell">
              <span>已签到计薪工时</span>
              <strong>
                <Hours minutes={snapshot.metrics.paidMinutes} />
              </strong>
              <small>有效签到班次合计</small>
            </div>
            <div className="metric-cell">
              <span>加班工时</span>
              <strong>
                <Hours minutes={snapshot.metrics.overtimeMinutes} />
              </strong>
              <small>已签到或已补记的加班</small>
            </div>
            <div className="metric-cell">
              <span>到岗率</span>
              <strong>
                {snapshot.metrics.attendanceRate === null
                  ? "—"
                  : `${(snapshot.metrics.attendanceRate * 100).toFixed(1)}%`}
              </strong>
              <small>
                {snapshot.metrics.attendanceRate === null
                  ? "暂无已结束班次"
                  : `${snapshot.metrics.attendedEndedSlots}/${snapshot.metrics.endedSlots} 个已结束席位`}
              </small>
            </div>
            <div className="metric-cell">
              <span>迟到次数</span>
              <strong>{snapshot.metrics.lateCount}</strong>
              <small>{snapshot.metrics.manualUnjudgedCount} 条补记未判定</small>
            </div>
            <div className="metric-cell">
              <span>已结束未签到席位</span>
              <strong>{snapshot.metrics.missingEndedSlots}</strong>
              <small>团队缺口</small>
            </div>
            <div className="metric-cell">
              <span>请假次数</span>
              <strong>{snapshot.metrics.leaveCount}</strong>
              <small>无代班请假不计缺勤</small>
            </div>
          </section>
          <section className="dashboard-section">
            <div className="card-title-row">
              <div>
                <h2>成员汇总</h2>
                <p>点击成员查看同一时间范围内的签到明细。</p>
              </div>
              <StatusPill tone="gray">{snapshot.members.length} 人</StatusPill>
            </div>
            {snapshot.members.length === 0 ? (
              <EmptyState
                title="暂无成员"
                description="请先导入成员资料或排班。"
              />
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>姓名</th>
                      <th>已签到班次</th>
                      <th>常规工时</th>
                      <th>加班工时</th>
                      <th>总工时</th>
                      <th>请假</th>
                      <th>迟到</th>
                      <th>临时替班</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.members.map((member) => (
                      <tr key={member.memberId}>
                        <td>
                          <AppButton
                            variant="quiet"
                            onClick={() =>
                              onOpenRecords({
                                ...filters,
                                memberId: member.memberId,
                              })
                            }
                          >
                            {member.memberName}
                          </AppButton>
                        </td>
                        <td>{member.shiftCount}</td>
                        <td>
                          <Hours minutes={member.regularMinutes} />
                        </td>
                        <td>
                          <Hours minutes={member.overtimeMinutes} />
                        </td>
                        <td>
                          <strong>
                            <Hours minutes={member.totalMinutes} />
                          </strong>
                        </td>
                        <td>{member.leaveCount}</td>
                        <td>{member.lateCount}</td>
                        <td>{member.substituteCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
