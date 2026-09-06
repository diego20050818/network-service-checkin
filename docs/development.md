# 开发规范

## 目录

```text
apps/desktop/          Electron 可部署应用
tests/e2e/             跨进程端到端测试
docs/                  需求、架构、流程与模块文档
infra/                 本项目无服务器基础设施的边界说明
scripts/               根级 PowerShell 验证与打包脚本
```

`apps/web`、`apps/mobile`、`apps/api` 和 `apps/worker` 只在出现已批准的独立部署需求后创建。

## 本地开发

使用 Node 24.18 或更高版本，并在 PowerShell 中调用 `npm.cmd`，避免系统执行策略拦截 `npm.ps1`。

```powershell
npm.cmd install
npm.cmd run dev
```

## Git 与分支

- 主分支为 `main`，保持可构建。
- 功能分支使用 `feat/<topic>`，修复使用 `fix/<topic>`，文档使用 `docs/<topic>`。
- 提交信息使用 `feat:`, `fix:`, `test:`, `docs:`, `chore:` 前缀。
- 每个提交只处理一个可解释变更，不提交数据库、用户导出、备份、日志或 `node_modules`。

## 代码规则

- 业务边界放在领域函数或主进程服务，不在 React 组件中复制。
- IPC 请求必须经过 Zod 校验；渲染端只调用 preload 暴露的窄接口。
- 所有时长内部使用整数分钟，显示时再换算小时。
- 所有写操作先验证，再开启事务；成功落库后才向界面返回成功。
- 测试夹具不能包含运行环境的真实历史个人数据。

