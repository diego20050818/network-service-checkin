import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import ExcelJS from 'exceljs';
import { _electron as electron, expect } from '@playwright/test';
import { DatabaseStore } from '../apps/desktop/src/main/database';
import { MemberService } from '../apps/desktop/src/main/services/member-service';
import { AttendanceService } from '../apps/desktop/src/main/services/attendance-service';
import { AdjustmentService } from '../apps/desktop/src/main/services/adjustment-service';
import { SettingsService } from '../apps/desktop/src/main/services/settings-service';
import { addScheduleImport, addShift } from '../apps/desktop/src/main/services/test-helpers.test-util';
import { formatLocalDate, addDays } from '../apps/desktop/src/domain/time';
import { mondayOfWeek } from '../apps/desktop/src/domain/weekly-calendar';

async function main() {
  const root = resolve('.');
  const shots = join(root, 'docs/manual/screenshots');
  await mkdir(shots, { recursive: true });
  await mkdir(join(root, '.tmp'), { recursive: true });
  const userData = await mkdtemp(join(root, '.tmp/manual-demo-'));
  const data = join(userData, 'data');
  await mkdir(join(data, 'schedule-sources'), { recursive: true });
  const store = new DatabaseStore(join(data, 'app.sqlite3'));
  const members = new MemberService(store, join(data, 'member-sources'));
  const attendance = new AttendanceService(store, members);
  const adjustments = new AdjustmentService(store, members, attendance);
  const today = formatLocalDate(new Date());
  const month = today.slice(0, 7);
  const nowHour = new Date().getHours();
  const start = `${String(nowHour).padStart(2, '0')}:00`;
  const end = nowHour < 23 ? `${String(nowHour + 1).padStart(2, '0')}:00` : '23:59';
  const employee = new ExcelJS.Workbook();
  employee.addWorksheet('成员').addRows([
    ['姓名', '所属学院', '职务', '学号', '年级'],
    ['张同学', '信息学院', '组员', '示例001', '2024'],
    ['李同学', '信息学院', '组员', '示例002', '2024'],
    ['王同学', '计算机学院', '组长', '示例003', '2023'],
  ]);
  const employeeFile = join(userData, '成员信息示例.xlsx');
  await employee.xlsx.writeFile(employeeFile);
  await members.importWorkbook(employeeFile);
  const source = join(data, 'schedule-sources', '本月排班示例.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('排班');
  sheet.addRows([
    ['工作日坐班'], ['时段', '周一', '周二', '周三', '周四', '周五'],
    ['08:00-10:00', '张同学', '李同学', '王同学', '张同学', '李同学'],
    ['10:00-12:00', '李同学', '王同学', '张同学', '李同学', '王同学'],
    ['维修班'], ['时段', '周一', '周二', '周三', '周四', '周五', '周六', '周日'],
    [`${start}-${end}`, ...Array(7).fill('张同学、李同学、王同学')],
  ]);
  await workbook.xlsx.writeFile(source);
  const importId = addScheduleImport(store, month);
  store.prepare('UPDATE schedule_imports SET source_name = ?, source_path = ? WHERE id = ?').run('本月排班示例.xlsx', source, importId);
  const monday = mondayOfWeek(new Date());
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    const names = ['张同学', '李同学', '王同学'];
    for (let j = 0; j < 2; j++) {
      const shift = addShift(store, members, { importId, date, kind: i < 5 ? 'desk' : 'weekend', startTime: j ? '10:00' : '08:00', endTime: j ? '12:00' : '10:00', paidMinutes: 120, people: [names[(i+j)%3]!] });
      if (date <= today && (i+j)%3 !== 1) attendance.checkIn(shift.shiftId, [{slotId:shift.slotIds[0]!,memberId:shift.memberIds[names[(i+j)%3]!]!}], `${date}T${j ? '10:03' : '08:05'}:00+08:00`);
    }
  }
  const current = addShift(store, members, { importId, date: today, kind:'maintenance', startTime:start, endTime:end, paidMinutes:nowHour < 23 ? 60 : 59, people:['张同学','李同学','王同学'] });
  if (nowHour < 23) addShift(store, members, { importId, date:today,kind:'weekend',startTime:'23:30',endTime:'23:59',paidMinutes:29,people:['王同学'] });
  const adjusted = addShift(store, members, { importId, date:today,kind:'desk',startTime:'22:00',endTime:'23:00',paidMinutes:60,people:['张同学'] });
  adjustments.createLeave({slotId:adjusted.slotIds[0]!,replacementMemberId:members.findByExactName('李同学')[0]!.id,reason:'课程冲突'},new Date(`${today}T21:00:00+08:00`));
  adjustments.addShiftStaff({shiftId:adjusted.shiftId,memberId:members.findByExactName('王同学')[0]!.id});
  const overtime = adjustments.createOvertime({memberId:members.findByExactName('张同学')[0]!.id,date:today,startTime:start,endTime:end,note:'晚间机房维护'});
  attendance.checkIn(overtime.shiftId,[{slotId:overtime.slotId,memberId:overtime.memberId}],new Date().toISOString());
  adjustments.createOvertime({memberId:members.findByExactName('李同学')[0]!.id,date:today,startTime:start,endTime:end,note:'协助巡检'});
  new SettingsService(store).updateStorage({defaultOutputDirectory:join(data,'exports'),backupDirectory:join(data,'backups')});
  store.close();
  const env = {...process.env, NODE_ENV:'test'};
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({executablePath:join(root,'apps/desktop/release/win-unpacked/网络服务小组签到与月报.exe'),args:[`--user-data-dir=${userData}`,'--disable-gpu','--disable-breakpad','--no-sandbox'],env});
  try {
    const page = await application.firstWindow();
    await page.setViewportSize({width:1280,height:850});
    const shot = async (name:string, locator?:ReturnType<typeof page.locator>) => {
      await page.evaluate(() => document.fonts.ready);
      if (locator) {
        const height = await locator.evaluate(el=>el.getBoundingClientRect().height);
        await page.setViewportSize({width:1280,height:Math.max(850,Math.ceil(height)+240)});
        await locator.evaluate(el=>el.scrollIntoView({block:'center'}));
        await locator.screenshot({path:join(shots,`${name}.png`)});
        await page.setViewportSize({width:1280,height:850});
      } else await page.screenshot({path:join(shots,`${name}.png`)});
      console.log(`Captured ${name}`);
    };
    const nav = async (name:string) => {await page.getByRole('button',{name,exact:true}).click();await page.evaluate(()=>window.scrollTo(0,0));};
    await expect(page.locator('.day-shift-row.current').first()).toBeVisible();
    await shot('01-签到首页');
    const row = page.locator('.day-shift-row.current').filter({has:page.getByRole('heading',{name:'维修班',exact:true})});
    await row.getByLabel('选择席位 1').check();
    await shot('02-选择到场人员',row);
    await row.getByRole('button',{name:'为所选 1 人签到'}).click();
    await expect(row.locator('.signed-person')).toContainText('张同学');
    await shot('03-签到成功',row);
    await nav('看板');
    await expect(page.locator('.week-event').first()).toBeVisible();
    await page.getByLabel('周班表日历').evaluate(el=>el.scrollTop=0);
    await shot('04-周班表');
    await page.locator('.metric-grid').scrollIntoViewIfNeeded();
    await shot('05-工时汇总');
    await nav('请假与加班');
    await expect(page.getByRole('heading',{name:'加班安排'})).toBeVisible();
    await shot('19-请假与加班',page.locator('.adjustment-shift-card').filter({hasText:'22:00-23:00'}));
    await shot('21-加班安排',page.locator('.dashboard-section').filter({has:page.getByRole('heading',{name:'加班安排',exact:true})}));
    await nav('排班与成员');
    await shot('06-导入排班和成员');
    await page.locator('.member-chips button').filter({hasText:'张同学'}).click();
    await shot('07-编辑成员',page.locator('.editor-panel'));
    await shot('08-签到与迟到设置',page.locator('.card').filter({has:page.getByRole('heading',{name:'签到与迟到设置'})}));
    await nav('签到记录');
    await expect(page.getByRole('heading',{name:'记录明细'})).toBeVisible();
    await page.getByLabel('班次席位').selectOption({index:1});
    await page.locator('.manual-fields select').nth(1).selectOption({label:'李同学'});
    await shot('09-记录与补记');
    await shot('17-补记表单',page.locator('.manual-card'));
    const records = page.locator('.card').filter({has:page.getByRole('heading',{name:'记录明细'})});
    await records.locator('tbody tr').last().getByRole('button',{name:'撤销',exact:true}).click();
    await expect(records.getByRole('button',{name:'恢复',exact:true})).toBeVisible();
    await records.locator('tbody tr').first().locator('select').selectOption({label:'李同学'});
    await shot('18-记录明细',records);
    await records.getByRole('button',{name:'恢复',exact:true}).click();
    await nav('输出本月绩效文件');
    await expect(page.getByText('已保存',{exact:true})).toBeVisible();
    await page.getByLabel('填表人/统计者').fill('王同学');
    await page.getByLabel('完成的工作 1').fill('完成值班接待和校园网络报修登记。');
    await page.getByLabel('完成的工作 2').fill('整理本月常见故障及处理记录。');
    await page.getByLabel('下月安排 1').fill('继续做好日常值班，更新常见问题解答。');
    await expect(page.getByText('已保存',{exact:true})).toBeVisible();
    await page.evaluate(()=>window.scrollTo(0,0));
    await shot('10-月报信息与文件清单');
    await shot('11-工作报表编辑',page.locator('.report-editor fieldset').first());
    await page.locator('.file-item').filter({hasText:'全员绩效考核表'}).getByRole('button').click();
    await shot('12-绩效评分',page.locator('.performance-editor'));
    await page.locator('.file-item').filter({hasText:'工资考核表'}).getByRole('button').click();
    await shot('13-工资工作量',page.locator('.wage-editor'));
    await nav('设置');
    await expect(page.locator('.settings-file-table').getByText('本月排班示例.xlsx',{exact:true})).toBeVisible();
    await shot('14-系统与文件位置');
    await shot('20-更新设置',page.locator('.update-settings-row'));
    await shot('15-当前使用文件',page.locator('.settings-section').filter({has:page.getByRole('heading',{name:'当前使用的文件'})}));
    await page.getByRole('button',{name:'立即备份',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('备份完成');
    await shot('16-备份管理',page.locator('.settings-section').filter({has:page.getByRole('heading',{name:'备份管理'})}));
    await writeFile(join(root,'.tmp/manual-capture.json'),JSON.stringify({version:'0.5.0',capturedAt:new Date().toISOString(),userData,screenshots:21,demoNames:['张同学','李同学','王同学']},null,2));
  } finally { await application.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
