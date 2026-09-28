# mini-DSH

按照 [从零手写 mini-dsh 学习指南](https://github.com/huangjunsen0406/mini-dsh/blob/main/LEARNING.zh-CN.md) 实现的 Agent Harness。第 0～7 天主线及补充篇已完成，每个阶段分别提交。

## 运行

需要 Node.js >= 20.18.1 和 pnpm 11.22.0。Windows 的 Bash 工具优先使用 Git for Windows 自带的 Bash；其他平台使用 PATH 中的 `bash`。

```powershell
pnpm install
Copy-Item .env.example .env
# 在 .env 中填写 DEEPSEEK_API_KEY
pnpm start
```

`.env.example` 默认选择 `deepseek/deepseek-v4-flash`；未设置 `MINI_DSH_MODEL` 时选择 `deepseek/deepseek-v4-pro`。`MINI_DSH_WORKSPACE` 指定工作目录，默认是启动目录。Context7 为可选 MCP 服务，连接失败仍可进入 CLI。

CLI 支持 `/tools`、`/models`、`/model`、`/model provider/model`、`/history`、`/prompt`、`/reset` 和 `/exit`。`/reset` 清空事件但保留 session id。运行时按 Esc 取消，方向键不会触发取消。

写文件、编辑文件和执行 Bash 前会询问 `Allow this? [Y/n]`，空回车或 `y` / `yes` 同意。审批期间 Esc 不取消运行。`MINI_DSH_AUTO_APPROVE=1` 可用于受信任的测试环境。

## 结构

入口负责装配插件；`core/` 实现事件日志、工具注册表、提示词、模型路由和 Agent Loop；`plugins/` 将 runtime 暴露为 Cordis 服务；`models/` 实现 DeepSeek 流式协议；`tools/` 注册 Bash 和五个文件工具。

请求经过 CLI → agent.send → Agent Loop → Session Event Log → LLM；模型请求工具时经过 ToolRuntime，记录结果后继续下一轮。Loop 通过服务契约工作，不依赖具体模型或工具，没有固定步数上限。

路径闸门检查词法路径、真实路径及尚未创建文件的父目录，拒绝软链越界。命令策略用于防止误操作，审批负责确认执行；这是应用层策略，不是操作系统隔离。

## 验证

```powershell
pnpm check
pnpm test
```

共 22 条测试：20 条核心测试以及 2 条真实 Cordis 集成测试。集成测试使用模拟模型，但实际执行 Bash，并验证文件工具、工具卸载和可选/必需插件的失败行为。测试不需要 API Key。
