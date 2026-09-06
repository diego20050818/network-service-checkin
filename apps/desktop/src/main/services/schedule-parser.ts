import ExcelJS, { type Cell } from "exceljs";
import type { ShiftKind } from "../../shared/contracts";
import { formatLocalDate, paidMinutesBetween } from "../../domain/time";

export interface ParsedShiftDefinition {
  date: string;
  kind: ShiftKind;
  label: string;
  startTime: string;
  endTime: string;
  paidMinutes: number;
  people: Array<string | null>;
}

export interface ParsedSchedule {
  shifts: ParsedShiftDefinition[];
  warnings: string[];
}

const DAY_TOKENS: Array<{ weekday: number; tokens: string[] }> = [
  { weekday: 1, tokens: ["周一", "星期一", "礼拜一"] },
  { weekday: 2, tokens: ["周二", "星期二", "礼拜二"] },
  { weekday: 3, tokens: ["周三", "星期三", "礼拜三"] },
  { weekday: 4, tokens: ["周四", "星期四", "礼拜四"] },
  { weekday: 5, tokens: ["周五", "星期五", "礼拜五"] },
  { weekday: 6, tokens: ["周六", "星期六", "礼拜六"] },
  { weekday: 0, tokens: ["周日", "星期日", "星期天", "礼拜日", "礼拜天"] },
];

const VACANCY_VALUES = new Set(["", "待补", "空位", "空缺", "无", "/", "-"]);

function normalized(value: string): string {
  return value.replace(/\u3000/g, " ").replace(/[：]/g, ":").replace(/\s+/g, "").trim();
}

function cellText(cell: Cell): string {
  const target = cell.isMerged ? cell.master : cell;
  if (typeof target.value === "number" && target.value >= 0 && target.value < 1) {
    const total = Math.round(target.value * 24 * 60);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }
  if (target.value instanceof Date) {
    return `${String(target.value.getHours()).padStart(2, "0")}:${String(target.value.getMinutes()).padStart(2, "0")}`;
  }
  return target.text.trim();
}

function timeRangeFromText(value: string): { startTime: string; endTime: string } | null {
  const range = /(\d{1,2}:\d{2})\s*(?:-|—|–|~|～|至)\s*(\d{1,2}:\d{2})/.exec(value.replace(/[：]/g, ":"));
  return range?.[1] && range[2]
    ? { startTime: range[1].padStart(5, "0"), endTime: range[2].padStart(5, "0") }
    : null;
}

function timeRangeForRow(worksheet: ExcelJS.Worksheet, rowNumber: number): { startTime: string; endTime: string } | null {
  const values: string[] = [];
  for (let column = 1; column <= worksheet.columnCount; column += 1) {
    const text = cellText(worksheet.getCell(rowNumber, column));
    if (text) values.push(text);
  }
  const combinedRange = timeRangeFromText(values.join(" "));
  if (combinedRange) return combinedRange;
  const times = values
    .map((value) => /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(normalized(value)))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`);
  return times.length >= 2 && times[0] && times[1] ? { startTime: times[0], endTime: times[1] } : null;
}

function splitPeople(value: string): Array<string | null> {
  const cleaned = value.trim();
  if (VACANCY_VALUES.has(normalized(cleaned))) return [null];
  return cleaned
    .split(/[、,，;；\n/]+/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => (VACANCY_VALUES.has(normalized(name)) ? null : name));
}

function dayColumns(worksheet: ExcelJS.Worksheet, startRow: number, endRow: number): Map<number, number> {
  const result = new Map<number, number>();
  for (let row = startRow; row <= Math.min(endRow, startRow + 8); row += 1) {
    for (let column = 1; column <= worksheet.columnCount; column += 1) {
      const value = normalized(cellText(worksheet.getCell(row, column)));
      const day = DAY_TOKENS.find((candidate) => candidate.tokens.some((token) => value === token || value.includes(token)));
      if (day && !result.has(day.weekday)) result.set(day.weekday, column);
    }
  }
  return result;
}

function datesForWeekday(year: number, month: number, weekday: number): string[] {
  const result: string[] = [];
  const lastDay = new Date(year, month, 0).getDate();
  for (let day = 1; day <= lastDay; day += 1) {
    const date = new Date(year, month - 1, day);
    if (date.getDay() === weekday) result.push(formatLocalDate(date));
  }
  return result;
}

function nthWeekdayDate(year: number, month: number, weekday: number, occurrence: number): string | null {
  return datesForWeekday(year, month, weekday)[occurrence - 1] ?? null;
}

function weekNumberFromText(text: string): number | null {
  const match = /第\s*([1-5一二三四五])\s*周/.exec(text);
  if (!match?.[1]) return null;
  return { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 }[match[1]] ?? Number(match[1]);
}

function weekNumberForRow(worksheet: ExcelJS.Worksheet, rowNumber: number): number | null {
  for (let row = rowNumber; row >= Math.max(1, rowNumber - 2); row -= 1) {
    const text = Array.from({ length: worksheet.columnCount }, (_, index) => cellText(worksheet.getCell(row, index + 1))).join(" ");
    const occurrence = weekNumberFromText(text);
    if (occurrence) return occurrence;
  }
  return null;
}

function weekendMatrixDefinitions(
  worksheet: ExcelJS.Worksheet,
  section: { kind: ShiftKind; label: string; start: number; end: number },
  year: number,
  month: number,
): ParsedShiftDefinition[] {
  const columns: Array<{ column: number; weekday: number; range: { startTime: string; endTime: string } }> = [];
  for (let row = section.start; row <= Math.min(section.end, section.start + 8); row += 1) {
    for (let column = 1; column <= worksheet.columnCount; column += 1) {
      const value = normalized(cellText(worksheet.getCell(row, column)));
      const day = DAY_TOKENS.find((candidate) =>
        (candidate.weekday === 6 || candidate.weekday === 0)
        && candidate.tokens.some((token) => value.includes(token) && value !== token),
      );
      if (!day) continue;
      for (let timeRow = row + 1; timeRow <= Math.min(section.end, row + 3); timeRow += 1) {
        const sourceRange = timeRangeFromText(cellText(worksheet.getCell(timeRow, column)));
        if (sourceRange) {
          const range = value.includes("上午")
            ? { startTime: "08:00", endTime: "12:00" }
            : value.includes("下午")
              ? { startTime: "14:30", endTime: "17:30" }
              : sourceRange;
          columns.push({ column, weekday: day.weekday, range });
          break;
        }
      }
    }
  }
  if (columns.length < 2) return [];

  const definitions: ParsedShiftDefinition[] = [];
  for (let row = section.start; row <= section.end; row += 1) {
    const rowText = Array.from({ length: worksheet.columnCount }, (_, index) => cellText(worksheet.getCell(row, index + 1))).join(" ");
    const occurrence = weekNumberFromText(rowText);
    if (!occurrence) continue;
    for (const entry of columns) {
      const date = nthWeekdayDate(year, month, entry.weekday, occurrence);
      if (!date) continue;
      const people = splitPeople(cellText(worksheet.getCell(row, entry.column))).filter((person): person is string => Boolean(person));
      if (people.length === 0) continue;
      definitions.push({
        date,
        kind: "weekend",
        label: section.label,
        ...entry.range,
        paidMinutes: paidMinutesBetween(entry.range.startTime, entry.range.endTime),
        people,
      });
    }
  }
  return definitions;
}

function sectionRows(worksheet: ExcelJS.Worksheet): Array<{ kind: ShiftKind; label: string; start: number; end: number }> {
  const markers: Array<{ kind: ShiftKind; label: string; row: number }> = [];
  for (let row = 1; row <= worksheet.rowCount; row += 1) {
    const values = Array.from({ length: worksheet.columnCount }, (_, index) => normalized(cellText(worksheet.getCell(row, index + 1))));
    if (values.includes("工作日坐班")) markers.push({ kind: "desk", label: "工作日坐班", row });
    else if (values.includes("维修班")) markers.push({ kind: "maintenance", label: "维修班", row });
    else if (values.includes("周末坐班")) markers.push({ kind: "weekend", label: "周末坐班", row });
  }
  markers.sort((a, b) => a.row - b.row);
  return markers.map((marker, index) => ({
    kind: marker.kind,
    label: marker.label,
    start: marker.row,
    end: (markers[index + 1]?.row ?? worksheet.rowCount + 1) - 1,
  }));
}

function mergeDefinitions(definitions: ParsedShiftDefinition[]): ParsedShiftDefinition[] {
  const byKey = new Map<string, ParsedShiftDefinition>();
  for (const definition of definitions) {
    const key = `${definition.date}|${definition.kind}|${definition.startTime}|${definition.endTime}`;
    const existing = byKey.get(key);
    if (existing) existing.people.push(...definition.people);
    else byKey.set(key, { ...definition, people: [...definition.people] });
  }
  return [...byKey.values()]
    .map((definition) => {
      const required = definition.kind === "maintenance" ? 3 : 1;
      const people = definition.people.filter((person): person is string => Boolean(person)).slice(0, required);
      return { ...definition, people };
    })
    .filter((definition) => definition.people.length > 0)
    .sort((a, b) => `${a.date}T${a.startTime}|${a.kind}`.localeCompare(`${b.date}T${b.startTime}|${b.kind}`));
}

export async function parseScheduleWorkbook(filePath: string, monthValue: string): Promise<ParsedSchedule> {
  const match = /^(\d{4})-(\d{2})$/.exec(monthValue);
  if (!match?.[1] || !match[2]) throw new Error("排班月份必须使用 YYYY-MM");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error("排班月份无效");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("排班文件没有工作表");
  const sections = sectionRows(worksheet);
  const warnings: string[] = [];
  const definitions: ParsedShiftDefinition[] = [];

  for (const section of sections) {
    if (section.kind === "weekend") {
      const matrixDefinitions = weekendMatrixDefinitions(worksheet, section, year, month);
      if (matrixDefinitions.length > 0) {
        definitions.push(...matrixDefinitions);
        continue;
      }
    }
    const columns = dayColumns(worksheet, section.start, section.end);
    const allowedDays = section.kind === "desk" ? [1, 2, 3, 4, 5] : section.kind === "weekend" ? [6, 0] : [1, 2, 3, 4, 5, 6, 0];
    for (let row = section.start; row <= section.end; row += 1) {
      const range = timeRangeForRow(worksheet, row);
      if (!range) continue;
      paidMinutesBetween(range.startTime, range.endTime);
      for (const weekday of allowedDays) {
        const column = columns.get(weekday);
        if (!column) continue;
        const raw = cellText(worksheet.getCell(row, column));
        const people = splitPeople(raw).filter((person): person is string => Boolean(person));
        if (people.length === 0) continue;
        if (section.kind === "weekend") {
          const occurrence = weekNumberForRow(worksheet, row);
          if (!occurrence) {
            warnings.push(`周末坐班第 ${row} 行缺少“第 N 周”标识，已跳过`);
            continue;
          }
          const date = nthWeekdayDate(year, month, weekday, occurrence);
          if (!date) continue;
          definitions.push({
            date,
            kind: section.kind,
            label: section.label,
            ...range,
            paidMinutes: paidMinutesBetween(range.startTime, range.endTime),
            people,
          });
        } else {
          for (const date of datesForWeekday(year, month, weekday)) {
            definitions.push({
              date,
              kind: section.kind,
              label: section.label,
              ...range,
              paidMinutes: paidMinutesBetween(range.startTime, range.endTime),
              people,
            });
          }
        }
      }
    }
  }

  const merged = mergeDefinitions(definitions);
  if (!sections.some((section) => section.kind === "desk")) warnings.push("未识别“工作日坐班”区域");
  if (!sections.some((section) => section.kind === "maintenance")) warnings.push("未识别“维修班”区域");
  if (!sections.some((section) => section.kind === "weekend")) warnings.push("未识别“周末坐班”区域");
  for (const weekday of [6, 0]) {
    if (datesForWeekday(year, month, weekday).length === 5) {
      const fifth = nthWeekdayDate(year, month, weekday, 5);
      const hasFifth = merged.some((shift) => shift.kind === "weekend" && shift.date === fifth);
      if (!hasFifth) warnings.push(`${fifth} 是当月第 5 个${weekday === 6 ? "周六" : "周日"}，排班表未提供名单，保持未排`);
    }
  }
  if (merged.length === 0) throw new Error("未从排班表识别出任何班次，请检查三块区域标签、星期表头和时间格式");
  return { shifts: merged, warnings: [...new Set(warnings)] };
}
