import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isRecord } from '../core/event-store.js'

// R07：MCP 默认不装、不联网。只读取用户目录级文件或显式给出的路径；工作区里出现 mcp.json
// 不会自动变成可信配置。secret 字段只接受完整的 `${ENV_NAME}` 引用，show-config 只展示变量名。
export interface McpServerDescriptor {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  toolCallTimeoutMs: number
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  envNames: string[]
  headerNames: string[]
  missingEnv: string[]
}

export interface McpConfigDescription {
  enabled: boolean
  source: string | null
  servers: McpServerDescriptor[]
  disabledReason?: string
}

export interface StdioMcpServer {
  package: '@deepseek-ai/dsh-mcp-client'
  required: false
  config: { serverName: string; transport: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd: string; toolCallTimeoutMs: number; failOnStartupError: false }
}

export interface HttpMcpServer {
  package: '@deepseek-ai/dsh-mcp-client'
  required: false
  config: { serverName: string; transport: 'streamable-http'; url: string; headers: Record<string, string>; toolCallTimeoutMs: number; failOnStartupError: false }
}

export type McpServerEntry = StdioMcpServer | HttpMcpServer

export interface McpLoadOptions {
  configPath?: string
  home?: string
  env?: NodeJS.ProcessEnv
}

const serverNamePattern = /^[A-Za-z0-9_-]{1,32}$/
const envReferencePattern = /^\$\{([A-Z_][A-Z0-9_]*)\}$/
const allowedServerKeys = {
  stdio: new Set(['serverName', 'transport', 'command', 'args', 'env', 'cwd', 'toolCallTimeoutMs']),
  'streamable-http': new Set(['serverName', 'transport', 'url', 'headers', 'toolCallTimeoutMs']),
}
const timeoutDefault = 60_000

function referenceNames(record: unknown, field: string, serverName: string): string[] {
  if (record === undefined) return []
  if (!isRecord(record)) throw new Error(`MCP server ${serverName}: ${field} must be an object`)
  const names: string[] = []
  for (const [name, value] of Object.entries(record)) {
    if (typeof value !== 'string') throw new Error(`MCP server ${serverName}: ${field}.${name} must be an environment reference`)
    const match = envReferencePattern.exec(value)
    if (!match) throw new Error(`MCP server ${serverName}: ${field}.${name} must be exactly \${ENV_NAME}; literal secrets are not accepted`)
    names.push(match[1]!)
  }
  return names
}

function resolveReferences(record: Record<string, string> | undefined, serverName: string, field: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [name, value] of Object.entries(record ?? {})) {
    const referenced = envReferencePattern.exec(value)![1]!
    const actual = env[referenced]
    if (!actual) throw new Error(`MCP server ${serverName}: environment variable ${referenced} is not set (${field}.${name})`)
    resolved[name] = actual
  }
  return resolved
}

function timeoutOf(raw: Record<string, unknown>, serverName: string): number {
  const value = raw.toolCallTimeoutMs
  if (value === undefined) return timeoutDefault
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`MCP server ${serverName}: toolCallTimeoutMs must be a positive safe integer`)
  return value
}

function parseServer(raw: unknown, index: number, env: NodeJS.ProcessEnv, baseDir: string, resolve: boolean): { descriptor: McpServerDescriptor; entry?: McpServerEntry } {
  if (!isRecord(raw)) throw new Error(`MCP server at index ${index} must be an object`)
  const serverName = raw.serverName
  if (typeof serverName !== 'string' || !serverNamePattern.test(serverName)) throw new Error(`MCP server at index ${index}: serverName must match [A-Za-z0-9_-]{1,32}`)
  const transport = raw.transport
  if (transport !== 'stdio' && transport !== 'streamable-http') throw new Error(`MCP server ${serverName}: transport must be stdio or streamable-http`)
  for (const key of Object.keys(raw)) if (!allowedServerKeys[transport].has(key)) throw new Error(`MCP server ${serverName}: unsupported field ${key}`)
  const toolCallTimeoutMs = timeoutOf(raw, serverName)
  if (transport === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) throw new Error(`MCP server ${serverName}: command is required`)
    if (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every(argument => typeof argument === 'string'))) throw new Error(`MCP server ${serverName}: args must be strings`)
    if (raw.cwd !== undefined && typeof raw.cwd !== 'string') throw new Error(`MCP server ${serverName}: cwd must be a string`)
    const envNames = referenceNames(raw.env, 'env', serverName)
    const missingEnv = envNames.filter(name => !env[name])
    return {
      descriptor: { serverName, transport, toolCallTimeoutMs, command: raw.command, args: (raw.args as string[] | undefined) ?? [], ...(raw.cwd ? { cwd: raw.cwd } : {}), envNames, headerNames: [], missingEnv },
      ...(resolve ? { entry: {
        package: '@deepseek-ai/dsh-mcp-client' as const, required: false as const,
        config: { serverName, transport, command: raw.command, args: (raw.args as string[] | undefined) ?? [],
          env: resolveReferences(raw.env as Record<string, string> | undefined, serverName, 'env', env),
          cwd: raw.cwd ? path.resolve(baseDir, raw.cwd) : baseDir, toolCallTimeoutMs, failOnStartupError: false as const },
      } } : {}),
    }
  }
  if (typeof raw.url !== 'string') throw new Error(`MCP server ${serverName}: url is required`)
  let url: URL
  try { url = new URL(raw.url) } catch { throw new Error(`MCP server ${serverName}: url must be an absolute http(s) URL`) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`MCP server ${serverName}: url must be an absolute http(s) URL`)
  const headerNames = referenceNames(raw.headers, 'headers', serverName)
  const missingEnv = headerNames.filter(name => !env[name])
  return {
    descriptor: { serverName, transport, toolCallTimeoutMs, url: raw.url, envNames: [], headerNames, missingEnv },
    ...(resolve ? { entry: {
      package: '@deepseek-ai/dsh-mcp-client' as const, required: false as const,
      config: { serverName, transport, url: raw.url, headers: resolveReferences(raw.headers as Record<string, string> | undefined, serverName, 'headers', env), toolCallTimeoutMs, failOnStartupError: false as const },
    } } : {}),
  }
}

async function readConfigFile(file: string): Promise<{ raw: unknown; source: string } | undefined> {
  let text: string
  try { text = await fs.readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error(`MCP config ${file} is not valid JSON`) }
  return { raw, source: path.resolve(file) }
}

function parseDocument(raw: unknown, source: string, env: NodeJS.ProcessEnv, resolve: boolean) {
  if (!isRecord(raw)) throw new Error(`MCP config ${source} must be a JSON object`)
  for (const key of Object.keys(raw)) if (key !== 'servers') throw new Error(`MCP config ${source}: unsupported field ${key}`)
  if (!Array.isArray(raw.servers)) throw new Error(`MCP config ${source}: servers must be an array`)
  const names = new Set<string>()
  const servers = raw.servers.map((server, index) => {
    const parsed = parseServer(server, index, env, path.dirname(source), resolve)
    if (names.has(parsed.descriptor.serverName)) throw new Error(`MCP config ${source}: duplicate serverName ${parsed.descriptor.serverName}`)
    names.add(parsed.descriptor.serverName)
    return parsed
  })
  return servers
}

function configPath(options: McpLoadOptions, env: NodeJS.ProcessEnv) {
  return options.configPath ?? env.MINI_DSH_MCP_CONFIG ?? path.join(options.home ?? os.homedir(), '.mini-dsh', 'mcp.json')
}

export async function describeMcpConfig(options: McpLoadOptions = {}): Promise<McpConfigDescription> {
  const env = options.env ?? process.env
  if (env.MINI_DSH_MCP === '0') return { enabled: false, source: null, servers: [], disabledReason: 'MINI_DSH_MCP=0' }
  const file = configPath(options, env)
  const config = await readConfigFile(file)
  if (!config) return { enabled: false, source: null, servers: [], disabledReason: 'no user-level MCP config' }
  const parsed = parseDocument(config.raw, config.source, env, false)
  return { enabled: parsed.length > 0, source: config.source, servers: parsed.map(server => server.descriptor) }
}

export async function loadMcpServers(options: McpLoadOptions = {}): Promise<{ servers: McpServerEntry[]; source: string | null }> {
  const env = options.env ?? process.env
  if (env.MINI_DSH_MCP === '0') return { servers: [], source: null }
  const file = configPath(options, env)
  const config = await readConfigFile(file)
  if (!config) return { servers: [], source: null }
  const parsed = parseDocument(config.raw, config.source, env, true)
  return { servers: parsed.flatMap(server => server.entry ? [server.entry] : []), source: config.source }
}
