import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FixtureId } from './coding-fixtures.js'

// NX-37：评测证据的来源指纹。报告要能自己回答「这份结论出自哪个提交、哪版 fixture、哪版运行时、
// 哪组采样参数」，否则留档只能靠散文里的人为对应关系维持——而 D-22／R-23 要求「仪器与结论对得上」时，
// 最先崩的恰恰是这一环：报告里没有提交号，就无法判断一份 12/12 是改动前还是改动后产出的。
// 摘要一律按 LF 归一后再算（理由见 estimation-corpus.ts 的 corpusDigest）：同一份 fixture 在 Windows
// 上被检出成 CRLF 时若也算出另一个摘要，摘要就不再只取决于内容。
const repository = fileURLToPath(new URL('../../', import.meta.url))
const fixturesDirectory = path.join(repository, 'test', 'fixtures', 'coding')

export interface GitProvenance {
  sha: string | null
  dirty: boolean | null
  error?: string
}
export interface SamplingProvenance {
  temperature: null
  seed: null
  thinking: string
  note: string
}
export interface FixtureProvenance {
  ids: readonly string[]
  sha256: string
  perFixture: Readonly<Record<string, string>>
}
export interface Provenance {
  startedAt: string
  git: GitProvenance
  runtime: { node: string; platform: string }
  sampling: SamplingProvenance
  fixtures: FixtureProvenance
}

export interface CommandResult { status: number | null; stdout: string; error?: Error }
export type CommandRunner = (command: string, args: readonly string[], cwd: string) => CommandResult

function spawn(command: string, args: readonly string[], cwd: string): CommandResult {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8', windowsHide: true })
  return { status: result.status, stdout: result.stdout ?? '', error: result.error }
}

// 取不到提交就如实写 null 并给出理由，绝不抛错：评测不该因为环境里没有 git 就跑不起来。但「不知道出处」
// 与「出处是这个提交」必须在报告里可区分——所以这里宁可留下一个显式的 error 字段，也不静默降级成空值。
// dirty 与 sha 同等重要：工作区脏时 HEAD 不能代表被执行的代码，报告必须把这件事说出来，否则一个
// 未提交的本地改动会让整批结论看起来出自那个干净的提交。
export function gitProvenance(directory: string, run: CommandRunner = spawn): GitProvenance {
  const head = run('git', ['rev-parse', 'HEAD'], directory)
  if (head.error || head.status !== 0) return { sha: null, dirty: null, error: 'not a git checkout (or git unavailable): this evidence cannot be tied to a revision' }
  const status = run('git', ['status', '--porcelain'], directory)
  if (status.error || status.status !== 0) return { sha: head.stdout.trim(), dirty: null, error: 'git status unavailable: the working tree state is unknown, so this revision may not describe the executed code' }
  return { sha: head.stdout.trim(), dirty: status.stdout.trim().length > 0 }
}

// 适配器实际发送的采样字段。temperature／seed 当前**不发送**（见 src/models/deepseek.ts 的请求体），
// 因此解码无法固定、重复运行只能各自采样——这件事必须写在报告里，而不是让读者默认它可复现。
// thinking 是每次请求都发的，并且默认值由 DEEPSEEK_THINKING 决定（评测入口构造适配器时不覆盖它）。
// 这份声明与真实请求体的一致性由 test/eval-provenance.test.ts 对着适配器发出的 body 钉住：适配器一旦
// 开始发送采样参数，这里的 null 就与事实不符，那条用例会变红。
export function samplingProvenance(env: Record<string, string | undefined> = process.env): SamplingProvenance {
  return {
    temperature: null,
    seed: null,
    thinking: env.DEEPSEEK_THINKING ?? 'enabled',
    note: 'temperature/seed are not sent: decoding is not pinned and repeat runs sample independently; thinking is sent on every request',
  }
}

async function fixtureFiles(directory: string, prefix = ''): Promise<{ path: string; content: string }[]> {
  const entries = await fs.readdir(path.join(directory, prefix), { withFileTypes: true })
  const files: { path: string; content: string }[] = []
  // 目录枚举顺序不作保证：先排序再摘要，使摘要只取决于内容而不取决于文件系统。
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await fixtureFiles(directory, relative))
    else if (entry.isFile()) files.push({ path: relative, content: await fs.readFile(path.join(directory, relative), 'utf8') })
    // 与 coding-fixtures.ts 的 protectedFilesIn 同一判据：符号链接等既不是文件也不是目录的条目会让
    // 「摘要覆盖了哪些字节」变得不可知，因此报错而不是跳过。
    else throw new Error(`invalid fixture entry: ${relative}`)
  }
  return files
}

// 摘要覆盖 fixture 目录下的每一个字节：任务文本（TASK.md／TASKS/*.md）、初始态、参考解与 verify.mjs
// 都在内。少覆盖任何一类，「任务内容没变」这句话就不再被这个摘要承担。
export async function fixtureDigest(id: FixtureId, directory = fixturesDirectory): Promise<string> {
  const hash = createHash('sha256')
  for (const file of await fixtureFiles(path.join(directory, id))) {
    hash.update(`${file.path}\0${file.content.replace(/\r\n/g, '\n')}\n`)
  }
  return hash.digest('hex')
}

// 聚合摘要按 id 排序后再算：同一组 fixture 换个顺序传入必须得到同一个摘要，否则「对照 A 的两臂拿到
// 相同任务集」这句话就无法由摘要核对。perFixture 单独保留，是为了让摘要变化时能点名是哪一个 fixture
// 变了，而不是只告诉人「这组不一样了」。
export async function fixtureProvenance(ids: readonly FixtureId[], directory = fixturesDirectory): Promise<FixtureProvenance> {
  const entries = await Promise.all(ids.map(async id => [id, await fixtureDigest(id, directory)] as const))
  const perFixture = Object.fromEntries(entries)
  const hash = createHash('sha256')
  hash.update([...ids].sort().map(id => `${id}\0${perFixture[id]}`).join('\n'))
  return { ids: [...ids], sha256: hash.digest('hex'), perFixture }
}

export async function buildProvenance(repositoryDirectory: string, fixtureIds: readonly FixtureId[], startedAt: string, env: Record<string, string | undefined> = process.env, run: CommandRunner = spawn): Promise<Provenance> {
  return {
    startedAt,
    git: gitProvenance(repositoryDirectory, run),
    runtime: { node: process.version, platform: process.platform },
    sampling: samplingProvenance(env),
    fixtures: await fixtureProvenance(fixtureIds, path.join(repositoryDirectory, 'test', 'fixtures', 'coding')),
  }
}
