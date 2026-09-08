import type { Member, RecordFilters } from "../../shared/contracts";
import { formatLocalDate, monthBounds } from "../../domain/time";
import { AppButton, AppInput, AppSelect } from "../ui";
export function resolvedFilters(context: RecordFilters) {
  const now = new Date();
  return { ...monthBounds(now.getFullYear(), now.getMonth() + 1), ...context };
}
export function RecordFiltersBar({
  members,
  value,
  onChange,
}: {
  members: Member[];
  value: RecordFilters;
  onChange(value: RecordFilters): void;
}) {
  const filters = resolvedFilters(value);
  return (
    <section className="filter-bar">
      <div className="button-row">
        <AppButton
          onClick={() => {
            const today = formatLocalDate(new Date());
            onChange({
              ...value,
              startDate: today,
              endDate: today,
              shiftId: undefined,
            });
          }}
        >
          今日
        </AppButton>
        <AppButton
          onClick={() => {
            const now = new Date();
            onChange({
              ...value,
              ...monthBounds(now.getFullYear(), now.getMonth() + 1),
              shiftId: undefined,
            });
          }}
        >
          本月
        </AppButton>
      </div>
      <label>
        开始日期
        <AppInput
          type="date"
          aria-label="开始日期"
          value={filters.startDate}
          onChange={(e) =>
            onChange({
              ...value,
              startDate: e.target.value,
              shiftId: undefined,
            })
          }
        />
      </label>
      <label>
        结束日期
        <AppInput
          type="date"
          aria-label="结束日期"
          value={filters.endDate}
          onChange={(e) =>
            onChange({ ...value, endDate: e.target.value, shiftId: undefined })
          }
        />
      </label>
      <label>
        成员
        <AppSelect
          aria-label="筛选成员"
          value={filters.memberId ?? ""}
          onChange={(e) =>
            onChange({ ...value, memberId: e.target.value || undefined })
          }
        >
          <option value="">全部成员</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </AppSelect>
      </label>
      <label>
        班次
        <AppSelect
          aria-label="筛选班次"
          value={filters.kind ?? "all"}
          onChange={(e) =>
            onChange({
              ...value,
              kind: e.target.value as RecordFilters["kind"],
              shiftId: undefined,
            })
          }
        >
          <option value="all">全部班次</option>
          <option value="desk">工作日坐班</option>
          <option value="maintenance">维修班</option>
          <option value="weekend">周末坐班</option>
          <option value="overtime">加班</option>
        </AppSelect>
      </label>
      {value.shiftId && (
        <AppButton
          variant="quiet"
          onClick={() => onChange({ ...value, shiftId: undefined })}
        >
          清除单次班次筛选 ×
        </AppButton>
      )}
    </section>
  );
}
