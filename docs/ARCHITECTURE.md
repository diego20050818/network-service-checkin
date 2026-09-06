# 架构设计

## 结论

首版只有一个可部署应用 `apps/desktop`。Electron 主进程承载本地应用服务，React 渲染进程承载界面；不创建本地 HTTP 服务，也不拆出 API 或 worker。这样可保持离线启动、单一安装包和较小运维面。

## 进程与边界

```text
React renderer
  -> typed contextBridge API
  -> validated IPC handlers
  -> attendance / schedule / dashboard / report / backup services
  -> node:sqlite + local files under Electron userData
```

渲染进程启用 sandbox 和 context isolation，关闭 node integration。文件导入、模板另存和输出目录只能来自系统文件选择器；模板、备份和数据库路径由主进程解析。模板下载只能从随包白名单文件复制。外部导航、窗口创建和权限请求默认拒绝。

## 主要模块

| 模块 | 职责 |
| --- | --- |
| `domain/time.ts` | 班次分钟、签到窗口、迟到边界、本地日期时间 |
| `domain/weekly-calendar.ts` | 周起点、负责人状态和重叠班次显示轨道 |
| `main/database.ts` | 迁移、SQLite 连接、事务、WAL 与安全快照 |
| `schedule-parser.ts` | 标签定位、三块 Excel 解析、周次展开、空缺保留 |
| `schedule-service.ts` | 排班源文件留存、成员解析、班次/席位版本写入 |
| `attendance-service.ts` | 批量签到、幂等、更正、撤销、恢复、人工补记 |
| `dashboard-service.ts` | 唯一工时聚合、团队指标、成员汇总与明细 |
| `report-service.ts` | 草稿、预览、模板映射、五类文件和导出快照 |
| `backup-service.ts` | 可配置目录、每日/手动安全备份、列表校验、30 份保留与恢复 |
| `startup-service.ts` | Windows 登录项读取、启用与关闭 |
| `storage-service.ts` | 文件目录设置、当前排班/员工/模板来源清单与路径授权 |

## 数据模型

- `members`：稳定 ID 与人员资料。
- `schedule_imports`：源文件副本、月份、生效日、哈希和解析结果。
- `member_imports`：员工文件副本、哈希、导入时间和人员数。
- `shifts` / `shift_slots`：具体日期班次及原排班席位快照。
- `attendance_records`：实际人员、打卡/录入时间、计薪分钟、迟到状态、来源和有效状态。
- `attendance_changes`：改错前后值、时间和来源，不声明操作者身份。
- `report_drafts`：周期参数、文字、评分、推荐、工资工作量和文件选择。
- `export_batches` / `export_files`：导出时数据快照、模板哈希和落盘路径。
- `settings`：迟到模式、阈值、扣分值、默认导出/备份目录和最近备份日。

数据库使用两个部分唯一索引保证“同一席位最多一条有效记录”和“同一班同一实际人员最多一条有效记录”。批量签到与记录修正均在单事务内完成。

## 文件生成

- 工作报表直接填充 assert DOCX 模板，替换跨 run 占位符。
- 绩效表与工资表以 assert 表格结构为适配基线，动态扩展成员行。
- 排班 DOCX 将导入的正式排班 Excel 工作表转换为 Word 表格；原始文件不可读时才从正式班次快照回退生成。
- 工时 XLSX 复用 example 对应模板的成员横向区块，并保留“签到明细”工作表；计划起止和计薪工时与真实打卡时间分开。

所有预览都来自与导出相同的结构化快照，不提供 Office 在线编辑功能。

## 时间口径

数据库按班次本地日期、`HH:mm` 和整数分钟保存。签到判断使用运行电脑本地时间；历史记录同时保留 ISO 时间戳及签到时的模式/阈值/判定。设置变化不重算既有记录。
