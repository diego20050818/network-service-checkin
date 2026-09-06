import type { DashboardFilters, DashboardSnapshot, MemberSummary, ShiftKind } from "../../shared/contracts";
import { dateFromOptionalIso, formatLocalDate, formatLocalTime } from "../../domain/time";
import type { DatabaseStore } from "../database";
import type { AttendanceService } from "./attendance-service";
import type { MemberService } from "./member-service";

type MetricRow = {
  paid_minutes: number;
  late_count: number;
  manual_unjudged_count: number;
};

export class DashboardService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly attendance: AttendanceService,
    private readonly members: MemberService,
  ) {}

  snapshot(filters: DashboardFilters): DashboardSnapshot {
    if (filters.startDate > filters.endDate) throw new Error("开始日期不能晚于结束日期");
    const now = dateFromOptionalIso(filters.now);
    const kindCondition = filters.kind && filters.kind !== "all" ? "AND s.kind = ?" : "";
    const baseParameters: Array<string> = [filters.startDate, filters.endDate];
    if (filters.kind && filters.kind !== "all") baseParameters.push(filters.kind);

    const metric = this.store
      .prepare(`
        SELECT
          COALESCE(SUM(ar.paid_minutes), 0) AS paid_minutes,
          COALESCE(SUM(CASE WHEN ar.late_status = 'late' THEN 1 ELSE 0 END), 0) AS late_count,
          COALESCE(SUM(CASE WHEN ar.late_status = 'manual_unjudged' THEN 1 ELSE 0 END), 0) AS manual_unjudged_count
        FROM attendance_records ar
        JOIN shifts s ON s.id = ar.shift_id
        WHERE ar.status = 'active' AND s.active = 1 AND s.date BETWEEN ? AND ? ${kindCondition}
      `)
      .get(...baseParameters) as MetricRow;

    const endedParameters: Array<string> = [filters.startDate, filters.endDate, formatLocalDate(now), formatLocalDate(now), formatLocalTime(now)];
    if (filters.kind && filters.kind !== "all") endedParameters.push(filters.kind);
    const ended = this.store
      .prepare(`
        SELECT COUNT(ss.id) AS ended_slots,
               COALESCE(SUM(CASE WHEN ar.id IS NOT NULL THEN 1 ELSE 0 END), 0) AS attended_slots
        FROM shifts s
        JOIN shift_slots ss ON ss.shift_id = s.id
        LEFT JOIN attendance_records ar ON ar.shift_slot_id = ss.id AND ar.status = 'active'
        WHERE s.active = 1 AND s.date BETWEEN ? AND ?
          AND (s.date < ? OR (s.date = ? AND s.end_time <= ?))
          AND ss.is_vacant = 0
          ${kindCondition}
      `)
      .get(...endedParameters) as { ended_slots: number; attended_slots: number };

    const records = this.attendance.listRecords({
      startDate: filters.startDate,
      endDate: filters.endDate,
      kind: filters.kind,
      memberId: filters.memberId,
    });
    const allRecords = filters.memberId
      ? this.attendance.listRecords({ startDate: filters.startDate, endDate: filters.endDate, kind: filters.kind })
      : records;
    const allMembers = this.members.list();
    const selectedMembers = filters.memberId ? allMembers.filter((member) => member.id === filters.memberId) : allMembers;
    const summaries: MemberSummary[] = selectedMembers.map((member) => {
      const memberRecords = allRecords.filter((record) => record.actualMemberId === member.id);
      const minutesFor = (kind: ShiftKind) =>
        memberRecords.filter((record) => record.kind === kind).reduce((total, record) => total + record.paidMinutes, 0);
      return {
        memberId: member.id,
        memberName: member.name,
        shiftCount: memberRecords.length,
        deskMinutes: minutesFor("desk"),
        maintenanceMinutes: minutesFor("maintenance"),
        weekendMinutes: minutesFor("weekend"),
        totalMinutes: memberRecords.reduce((total, record) => total + record.paidMinutes, 0),
        lateCount: memberRecords.filter((record) => record.lateStatus === "late").length,
        substituteCount: memberRecords.filter(
          (record) => !record.scheduledMemberName || record.scheduledMemberName !== record.actualMemberName,
        ).length,
      };
    });
    summaries.sort((a, b) => b.totalMinutes - a.totalMinutes || a.memberName.localeCompare(b.memberName, "zh-CN"));

    const endedSlots = Number(ended.ended_slots);
    const attendedEndedSlots = Number(ended.attended_slots);
    return {
      filters,
      metrics: {
        paidMinutes: Number(metric.paid_minutes),
        attendanceRate: endedSlots === 0 ? null : attendedEndedSlots / endedSlots,
        attendedEndedSlots,
        endedSlots,
        lateCount: Number(metric.late_count),
        missingEndedSlots: endedSlots - attendedEndedSlots,
        manualUnjudgedCount: Number(metric.manual_unjudged_count),
      },
      members: summaries,
      records,
    };
  }
}
