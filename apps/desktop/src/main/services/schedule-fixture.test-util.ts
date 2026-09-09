import ExcelJS from "exceljs";

export async function createThreeBlockSchedule(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("排班");
  sheet.addRow(["工作日坐班"]);
  sheet.addRow(["时段", "周一", "周二", "周三", "周四", "周五"]);
  sheet.addRow(["08：00–10：00", "甲", "乙", "丙", "丁", "戊"]);
  sheet.addRow(["16:15-17:30", "乙", "丙", "丁", "戊", "甲"]);
  sheet.addRow(["维修班"]);
  sheet.addRow(["时段", "周一", "周二", "周三", "周四", "周五", "周六", "周日"]);
  sheet.addRow(["17:00-19:00", "甲、乙、丙", "甲、乙、丙", "甲、乙、丙", "甲、乙、丙", "甲、乙、丙", "甲、乙、丙", "李佳欣、洪浩洋、待补"]);
  sheet.addRow(["周末坐班"]);
  sheet.addRow(["周次", "时段", "周六", "周日"]);
  for (let week = 1; week <= 4; week += 1) {
    sheet.addRow([`第${week}周`, "09:00-12:00", `周六${week}`, `周日${week}`]);
    sheet.addRow([`第${week}周`, "14:30-17:30", `周六${week}`, `周日${week}`]);
  }
  await workbook.xlsx.writeFile(path);
}

export async function createWeekendMatrixSchedule(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("排班");
  sheet.addRows([
    ["工作日坐班"],
    ["时段", "周一", "周二", "周三", "周四", "周五"],
    ["08:00-10:00", "甲", "乙", "丙", "丁", "戊"],
    ["维修班"],
    ["时段", "周一", "周二", "周三", "周四", "周五", "周六", "周日"],
    ["17:00-19:00", "甲、乙、丙", "甲、乙、丙", "甲、乙、丙", "甲、乙、丙", "甲、乙、丙", "甲、乙、丙", "甲、乙、丙"],
    ["周末坐班", "周次", "周六上午", "周六下午", "周日上午", "周日下午"],
    ["", "", "09:00-12:00", "14:30-17:30", "09:00-12:00", "14:30-17:30"],
    ["", "第1周", "方萌", "张三", "李四", "范浩天"],
    ["", "第2周", "王五", "赵六", "钱七", "孙八"],
    ["", "第3周", "周九", "吴十", "郑十一", "冯十二"],
    ["", "第4周", "陈十三", "褚十四", "卫十五", "蒋十六"],
  ]);
  await workbook.xlsx.writeFile(path);
}
