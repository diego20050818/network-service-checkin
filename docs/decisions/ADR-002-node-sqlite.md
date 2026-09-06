# ADR 002 使用 Electron 内置 Node SQLite

状态：已接受

## 决策

主进程使用 Electron 44 所带 Node 24 的 `node:sqlite`，不引入需要单独编译的原生 SQLite npm 扩展。

## 原因

它能减少 Windows 安装包中的 ABI 重建与额外运行依赖，同时提供事务、预编译语句、WAL 和 SQLite 原生约束。数据库只在主进程打开。

## 风险与控制

Node 24 文档仍将该模块标为候选稳定级别以下。项目锁定 Electron 小版本，并用数据库集成测试和安装包实机测试覆盖升级；若后续运行时移除或改变 API，再通过数据库适配器迁移。

