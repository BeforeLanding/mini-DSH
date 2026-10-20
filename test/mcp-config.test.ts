import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHarness } from '../src/app/create-harness.js'
import { describeMcpConfig, loadMcpServers, secureStdioEntry } from '../src/app/mcp-config.js'

const mockServer = path.resolve('test/fixtures/mcp/mock-server.mjs')
// 配置要求的是字面量 ${NAME}，不是本文件的模板插值。
const reference = (name: string) => '${' + name + '}'

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-mcp-'))
}

async function writeConfig(directory: string, servers: unknown[]) {
  const file = path.join(directory, 'mcp.json')
  await fs.writeFile(file, JSON.stringify({ servers }))
  return file
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { return true }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

const stdioServer = (overrides: Record<string, unknown> = {}) => ({
  serverName: 'mock', transport: 'stdio', command: process.execPath, args: [mockServer],
  toolCallTimeoutMs: 5_000, ...overrides,
})

test('MCP defaults to no server and never reads a workspace-local file', async () => {
  const home = await temporaryDirectory()
  try {
    const workspace = path.join(home, 'project')
    await fs.mkdir(workspace)
    await writeConfig(workspace, [stdioServer()])
    const loaded = await loadMcpServers({ home, env: {} })
    assert.deepEqual(loaded.servers, [])
    assert.equal(loaded.source, null)
    const described = await describeMcpConfig({ home, env: {} })
    assert.equal(described.enabled, false)
    assert.equal(described.servers.length, 0)
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('user config resolves env references only at load time and show-config keeps names but not values', async () => {
  const home = await temporaryDirectory()
  try {
    const file = await writeConfig(home, [stdioServer({ env: { MOCK_TOKEN: reference('MOCK_TOKEN') } })])
    const env = { MOCK_TOKEN: 'super-secret-token' }
    const described = await describeMcpConfig({ configPath: file, env })
    assert.equal(described.enabled, true)
    assert.equal(described.servers[0]?.envNames.join(','), 'MOCK_TOKEN')
    assert.deepEqual(described.servers[0]?.missingEnv, [])
    const serialized = JSON.stringify(described)
    assert.doesNotMatch(serialized, /super-secret-token/)
    assert.match(serialized, /MOCK_TOKEN/)
    const loaded = await loadMcpServers({ configPath: file, env })
    assert.equal(loaded.servers[0]?.config.serverName, 'mock')
    assert.equal(loaded.servers[0]?.config.transport, 'stdio')
    assert.equal(loaded.servers[0]?.config.transport === 'stdio' && loaded.servers[0].config.env.MOCK_TOKEN, 'super-secret-token')
    assert.equal(loaded.servers[0]?.config.failOnStartupError, false)
    assert.equal(loaded.servers[0]?.config.transport === 'stdio' && loaded.servers[0].config.cwd, home)
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('literal secrets, missing variables, duplicate names, unknown fields and bad transports are rejected', async () => {
  const home = await temporaryDirectory()
  try {
    const file = await writeConfig(home, [stdioServer({ env: { TOKEN: 'literal-secret' } })])
    await assert.rejects(loadMcpServers({ configPath: file, env: {} }), /literal secrets are not accepted/)
    await writeConfig(home, [stdioServer({ env: { TOKEN: reference('MISSING_TOKEN') } })])
    await assert.rejects(loadMcpServers({ configPath: file, env: {} }), /MISSING_TOKEN is not set/)
    const described = await describeMcpConfig({ configPath: file, env: {} })
    assert.deepEqual(described.servers[0]?.missingEnv, ['MISSING_TOKEN'])
    await writeConfig(home, [stdioServer(), stdioServer()])
    await assert.rejects(loadMcpServers({ configPath: file, env: {} }), /duplicate serverName mock/)
    await writeConfig(home, [stdioServer({ failOnStartupError: true })])
    await assert.rejects(loadMcpServers({ configPath: file, env: {} }), /unsupported field failOnStartupError/)
    await writeConfig(home, [{ serverName: 'mock', transport: 'websocket' }])
    await assert.rejects(loadMcpServers({ configPath: file, env: {} }), /transport must be stdio or streamable-http/)
    await writeConfig(home, [{ serverName: 'mock', transport: 'streamable-http', url: 'file:///tmp/x' }])
    await assert.rejects(loadMcpServers({ configPath: file, env: {} }), /absolute http\(s\) URL/)
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('MINI_DSH_MCP=0 disables an otherwise valid explicit config', async () => {
  const home = await temporaryDirectory()
  try {
    const file = await writeConfig(home, [stdioServer()])
    assert.deepEqual(await loadMcpServers({ configPath: file, env: { MINI_DSH_MCP: '0' } }), { servers: [], source: null })
    const described = await describeMcpConfig({ configPath: file, env: { MINI_DSH_MCP: '0' } })
    assert.equal(described.enabled, false)
    assert.equal(described.disabledReason, 'MINI_DSH_MCP=0')
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('a stdio server lists and calls namespaced tools, obeys timeout, and disappears after dispose', async () => {
  const home = await temporaryDirectory()
  const workspace = path.join(home, 'workspace')
  await fs.mkdir(workspace)
  const file = await writeConfig(home, [stdioServer({ toolCallTimeoutMs: 1_000 })])
  const loaded = await loadMcpServers({ configPath: file, env: {} })
  const harness = await createHarness({ workspace, profile: 'coding', autoApprove: true, mcpServers: loaded.servers })
  try {
    assert.ok(harness.capabilityManifest.tools.includes('mcp__mock__echo'))
    assert.deepEqual(harness.capabilityManifest.policy.mcpServers, ['mock'])
    // autoApprove 不会替未知/第三方工具自动授权；这里显式模拟用户在交互入口批准。
    harness.root.sandbox.setApprover(async () => true)
    const echoed = await harness.root.tools.execute('mcp__mock__echo', { text: 'hello' })
    assert.equal(echoed.isError, false)
    assert.match(harness.root.tools.renderResult(echoed), /echo:hello/)
    const slow = await harness.root.tools.execute('mcp__mock__slow', {})
    assert.equal(slow.isError, true)
    // 服务器在调用中退出：调用以错误返回，主循环与 dispose 都不被挂住。
    const crashed = await harness.root.tools.execute('mcp__mock__crash', {})
    assert.equal(crashed.isError, true)
  } finally { await harness.dispose() }
  // dispose 后工具服务连同注册项一起释放，不再能解析到已注册的 MCP 工具名。
  assert.equal((harness.root as unknown as { tools?: { get(name: string): unknown } }).tools?.get('mcp__mock__echo'), undefined)
  await fs.rm(home, { recursive: true, force: true })
})

test('third-party MCP tools cannot bypass central authorization', async () => {
  const home = await temporaryDirectory()
  const workspace = path.join(home, 'workspace')
  await fs.mkdir(workspace)
  const file = await writeConfig(home, [stdioServer()])
  const loaded = await loadMcpServers({ configPath: file, env: {} })
  const harness = await createHarness({ workspace, profile: 'coding', mcpServers: loaded.servers })
  try {
    harness.root.sandbox.setApprover(async request => request.tool !== 'mcp__mock__tick')
    const denied = await harness.root.tools.execute('mcp__mock__tick', {})
    assert.equal(denied.isError, true)
    const counter = await harness.root.tools.execute('mcp__mock__counter', {})
    assert.equal(harness.root.tools.renderResult(counter).trim(), '0')
    harness.root.sandbox.setApprover(async () => true)
    const ticked = await harness.root.tools.execute('mcp__mock__tick', {})
    assert.equal(ticked.isError, false)
    const after = await harness.root.tools.execute('mcp__mock__counter', {})
    assert.equal(harness.root.tools.renderResult(after).trim(), '1')
  } finally { await harness.dispose() }
  await fs.rm(home, { recursive: true, force: true })
})

test('stdio entries are launched through the explicit-environment launcher, idempotently', async () => {
  const home = await temporaryDirectory()
  try {
    const file = await writeConfig(home, [stdioServer()])
    const loaded = await loadMcpServers({ configPath: file, env: {} })
    const wrapped = secureStdioEntry(loaded.servers[0]!)
    assert.equal(wrapped.config.transport, 'stdio')
    if (wrapped.config.transport !== 'stdio') return
    assert.equal(wrapped.config.command, process.execPath)
    assert.match(wrapped.config.args[1] ?? '', /^--env-names$/)
    assert.match(wrapped.config.args[0] ?? '', /mcp-stdio-launcher\.js$/)
    assert.deepEqual(secureStdioEntry(wrapped), wrapped)
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('HOME, USERPROFILE and NODE_OPTIONS cannot be forwarded to a stdio server', async () => {
  const home = await temporaryDirectory()
  try {
    const file = await writeConfig(home, [])
    for (const name of ['HOME', 'USERPROFILE', 'NODE_OPTIONS']) {
      await writeConfig(home, [stdioServer({ env: { [name]: reference(name) } })])
      await assert.rejects(loadMcpServers({ configPath: file, env: { [name]: '/somewhere' } }), new RegExp(`${name} cannot be forwarded`))
    }
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})

test('the real stdio child gets only the explicit environment, its own HOME, and is reaped on dispose', async () => {
  const home = await temporaryDirectory()
  const workspace = path.join(home, 'workspace')
  await fs.mkdir(workspace)
  const file = await writeConfig(home, [stdioServer({ env: { MOCK_TOKEN: reference('MOCK_TOKEN') } })])
  const leaks = {
    DEEPSEEK_API_KEY: 'fake-provider-key',
    HTTP_PROXY: 'http://proxy.invalid:8080',
    HTTPS_PROXY: 'http://proxy.invalid:8443',
    ALL_PROXY: 'socks5://proxy.invalid:1080',
    SSH_AUTH_SOCK: '/tmp/mini-dsh-fake-agent.sock',
    NODE_OPTIONS: '--no-warnings',
    MOCK_TOKEN: 'explicit-token',
  }
  const previous = new Map(Object.keys(leaks).map(name => [name, process.env[name]] as const))
  for (const [name, value] of Object.entries(leaks)) process.env[name] = value
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined
  let pid: number | undefined
  try {
    const loaded = await loadMcpServers({ configPath: file, env: process.env })
    harness = await createHarness({ workspace, profile: 'coding', mcpServers: loaded.servers })
    harness.root.sandbox.setApprover(async () => true)
    const result = await harness.root.tools.execute('mcp__mock__environment', {})
    assert.equal(result.isError, false)
    const reported = JSON.parse(harness.root.tools.renderResult(result)) as Record<string, string | null>
    assert.equal(reported.DEEPSEEK_API_KEY, null)
    assert.equal(reported.HTTP_PROXY, null)
    assert.equal(reported.HTTPS_PROXY, null)
    assert.equal(reported.ALL_PROXY, null)
    assert.equal(reported.SSH_AUTH_SOCK, null)
    assert.equal(reported.NODE_OPTIONS, null)
    // 显式引用按契约传入，且允许运行所需的 PATH 仍在。
    assert.equal(reported.MOCK_TOKEN, 'explicit-token')
    assert.ok(reported.PATH)
    // 独立 HOME：不是父进程的真实目录。
    assert.ok(reported.HOME && path.isAbsolute(reported.HOME))
    assert.match(reported.HOME, /mini-dsh-mcp-/)
    if (process.platform === 'win32') assert.notEqual(reported.USERPROFILE, process.env.USERPROFILE)
    else assert.notEqual(reported.HOME, process.env.HOME)
    const pidText = harness.root.tools.renderResult(await harness.root.tools.execute('mcp__mock__pid', {}))
    pid = Number(pidText.trim())
    assert.ok(Number.isSafeInteger(pid) && pid > 0)
  } finally {
    await harness?.dispose()
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  try {
    assert.equal(await waitForProcessExit(pid!), true, `mock MCP server ${pid} survived dispose`)
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})
