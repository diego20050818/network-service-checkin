import ExcelJS from "exceljs";
import type { ShiftTimeSettings } from "../../shared/contracts";

function rangeText(settings: ShiftTimeSettings, key: keyof ShiftTimeSettings) {
  const range = settings[key];
  return `${range.startTime}–${range.endTime}`;
}

export function createScheduleImportTemplate(
  settings: ShiftTimeSettings,
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "网络服务小组签到与月报";
  workbook.created = new Date(0);
  const sheet = workbook.addWorksheet("排班", {
    views: [{ state: "frozen", ySplit: 2 }],
  });
  sheet.addRow(["工作日坐班"]);
  sheet.addRow(["时段", "周一", "周二", "周三", "周四", "周五"]);
  for (const key of [
    "weekdayDesk1",
    "weekdayDesk2",
    "weekdayDesk3",
    "weekdayDesk4",
  ] as const)
    sheet.addRow([rangeText(settings, key), "", "", "", "", ""]);
  sheet.addRow([]);
  sheet.addRow(["维修班"]);
  sheet.addRow([
    "时段",
    "周一",
    "周二",
    "周三",
    "周四",
    "周五",
    "周六",
    "周日",
  ]);
  sheet.addRow([
    rangeText(settings, "maintenance"),
    "",
    "",
    "",
    "",
    "",
    "",
    "",
  ]);
  sheet.addRow([]);
  sheet.addRow([
    "周末坐班",
    "周次",
    "周六上午",
    "周六下午",
    "周日上午",
    "周日下午",
  ]);
  sheet.addRow([
    "",
    "",
    rangeText(settings, "weekendMorning"),
    rangeText(settings, "weekendAfternoon"),
    rangeText(settings, "weekendMorning"),
    rangeText(settings, "weekendAfternoon"),
  ]);
  for (let week = 1; week <= 5; week += 1)
    sheet.addRow(["", `第${week}周`, "", "", "", ""]);

  sheet.columns = [
    { width: 22 },
    { width: 16 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
    { width: 16 },
    { width: 16 },
  ];
  for (const rowNumber of [1, 8, 12]) {
    const row = sheet.getRow(rowNumber);
    row.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
    row.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF7A2E2E" },
    };
  }
  for (const rowNumber of [2, 9, 13]) {
    const row = sheet.getRow(rowNumber);
    row.font = { bold: true };
    row.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF2E8E6" },
    };
  }
  sheet.eachRow((row) => {
    row.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    row.height = 24;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = {
        top: { style: "thin", color: { argb: "FFD8D3CC" } },
        left: { style: "thin", color: { argb: "FFD8D3CC" } },
        bottom: { style: "thin", color: { argb: "FFD8D3CC" } },
        right: { style: "thin", color: { argb: "FFD8D3CC" } },
      };
    });
  });
  sheet.getCell("A1").note = "在下方空白单元格填写值班人员；多人维修班用顿号分隔。";
  return workbook;
}

export async function writeScheduleImportTemplate(
  path: string,
  settings: ShiftTimeSettings,
): Promise<void> {
  await createScheduleImportTemplate(settings).xlsx.writeFile(path);
}
