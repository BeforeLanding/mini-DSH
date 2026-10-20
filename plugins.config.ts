// R07：不再内置任何 MCP server。原 context7 条目会在每次启动时联网，且只在交互入口装配。
// 现在 MCP 由用户目录级配置或显式 --mcp-config 提供，经 createHarness 的可选参数装配。
export default [] as { package: string; required?: boolean; config?: Record<string, unknown> }[]
