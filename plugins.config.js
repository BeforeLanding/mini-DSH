// Configuration for plugins used in the mini-DSH application, including the DeepSeek LLM provider.

const headers = {}
if (process.env.CONTEXT7_API_KEY) {
  headers.Authorization = `Bearer ${process.env.CONTEXT7_API_KEY}`
}

export default [{
  package: '@deepseek-ai/dsh-mcp-client',
  required: false,
  config: {
    serverName: 'context7', transport: 'streamable-http',
    url: 'https://mcp.context7.com/mcp', headers,
    failOnStartupError: false, toolCallTimeoutMs: 60_000,
  },
}]
