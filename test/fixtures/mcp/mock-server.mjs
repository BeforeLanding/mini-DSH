// Minimal stdio MCP server used only by test/mcp-config.test.ts. It intentionally has no
// dependencies: newline-delimited JSON-RPC is enough to exercise list, call, timeout and disconnect.
let buffer = ''
let counter = 0

const tools = [
  { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'tick', description: 'Increment an in-process counter', inputSchema: { type: 'object', properties: {} } },
  { name: 'counter', description: 'Read the in-process counter', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Never answers quickly', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash', description: 'Drop the transport', inputSchema: { type: 'object', properties: {} } },
]

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

async function handle(message) {
  if (message.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-mcp', version: '1.0.0' },
    } })
  }
  if (message.method === 'notifications/initialized') return
  if (message.method === 'ping') return send({ jsonrpc: '2.0', id: message.id, result: {} })
  if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools } })
  if (message.method === 'tools/call') {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    if (name === 'echo') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }] } })
    if (name === 'tick') { counter += 1; return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(counter) }] } }) }
    if (name === 'counter') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(counter) }] } })
    if (name === 'slow') { await new Promise(resolve => setTimeout(resolve, 10_000)); return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'late' }] } }) }
    if (name === 'crash') { process.exit(1) }
    return send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool ${name}` } })
  }
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim()) void handle(JSON.parse(line))
  }
})
