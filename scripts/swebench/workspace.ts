import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { classifyEnvironmentCommit, compareSourceTrees, describeSourceMismatch, parseRawDiff, parseTreeListing,
  summarizeRawDiff } from './source-consistency.js'

// 执行器只负责准备候选工作区。Agent 的文件工具直接写宿主目录；需容器 Bash 时再把同一目录
// 以只读根 + 单一 rw 挂载交给官方任务镜像。官方判分始终在另一个干净容器里进行。
function command(executable: string, args: string[], cwd?: string) {
  return execFileSync(executable, args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }).trim()
}

function raw(executable: string, args: string[], cwd?: string) {
  return execFileSync(executable, args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
}

function docker(...args: string[]) { return command('docker', args) }

function removeContainer(name: string) {
  if (!command('docker', ['ps', '-aq', '--filter', `name=^/${name}$`])) return
  docker('rm', '-f', name)
  if (docker('ps', '-aq', '--filter', `name=^/${name}$`)) throw new Error(`container remained after cleanup: ${name}`)
}

// One pinned Requests image contains an untracked setuptools build tree. Keep
// those files visible, as they are in the official scorer image, but do not
// mistake them for an Agent patch. No other image or dirty path is exempted.
const requestsBuildImage = 'sha256:b2733e57feb4cfaeac24ab5ec496d4cb89a37db53bd0ca72eaededdb2ce19d1c'
export async function ignorePinnedImageBuildArtifact(image: string, target: string): Promise<boolean> {
  if (image !== requestsBuildImage || command('git', ['status', '--porcelain'], target) !== '?? build/') return false
  const build = path.resolve(target, 'build')
  if (path.dirname(build) !== path.resolve(target)) throw new Error('build artifact escaped candidate workspace')
  const stat = await fs.lstat(build)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('pinned image build artifact is not a directory')
  await fs.appendFile(path.join(target, '.git', 'info', 'exclude'), '\n/build/\n')
  return true
}

// 批次恢复只清理本执行器命名规则下的容器；不会删除名字不匹配的任何资源。
export function removeContainerIfPresent(name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error('invalid container name')
  removeContainer(name)
}

export async function prepareFixtureWorkspace(source: string, target: string) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.cp(source, target, { recursive: true, errorOnExist: true })
  // 判分按 git 补丁进行；fixture 若本身不是仓库，就在这里建立稳定的基线提交。
  // 用 spawnSync 探测而不是 try/catch execFileSync，避免把预期的 “not a git repository” 写到 stderr。
  const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: target, encoding: 'utf8' })
  if (probe.status !== 0) {
    const identity = { ...process.env, GIT_AUTHOR_NAME: 'mini-dsh', GIT_AUTHOR_EMAIL: 'mini-dsh@example.invalid',
      GIT_COMMITTER_NAME: 'mini-dsh', GIT_COMMITTER_EMAIL: 'mini-dsh@example.invalid' }
    execFileSync('git', ['init', '-q'], { cwd: target, env: identity })
    execFileSync('git', ['add', '-A'], { cwd: target, env: identity })
    execFileSync('git', ['commit', '-qm', 'fixture base'], { cwd: target, env: identity })
  }
  return command('git', ['rev-parse', 'HEAD'], target)
}

export interface DockerExport {
  imageHead: string
  // Patch base for `git diff` after the episode. It is the dataset base when the
  // image tree is content-equal, and the image HEAD when only a declared build-
  // metadata environment commit differs. The official scorer applies the patch
  // to the same image tree the Agent worked on.
  patchBase: string
  environmentCommit: { imageHead: string; datasetBase: string; paths: string[] } | null
  evidence: Record<string, unknown>
}

export interface DockerCandidate extends DockerExport {
  containerName: string
  cleanup(): void
}

// Export the image's /testbed and verify it against the dataset base without
// starting a candidate container. The external baseline reuses this export and
// starts its own isolated container; the mini-DSH candidate then adds its
// long-lived container below.
export async function exportDockerWorkspace(options: { image: string; baseCommit: string; target: string; exportName: string }): Promise<DockerExport> {
  const { image, baseCommit, target, exportName } = options
  await fs.mkdir(target, { recursive: false })
  let exported = false
  try {
    if (docker('ps', '-aq', '--filter', `name=^/${exportName}$`)) throw new Error(`export container already exists: ${exportName}`)
    exported = true
    docker('create', '--name', exportName, image, 'sh', '-lc', 'true')
    docker('cp', `${exportName}:/testbed/.`, target)
    docker('rm', '-f', exportName)
    exported = false
    const checkoutRoot = command('git', ['rev-parse', '--show-toplevel'], target)
    const imageHead = command('git', ['rev-parse', 'HEAD'], target)
    const baseObject = spawnSync('git', ['cat-file', '-t', baseCommit], { cwd: target, encoding: 'utf8', timeout: 30_000 })
    if (path.resolve(checkoutRoot) !== path.resolve(target) || baseObject.status !== 0) throw new Error(`official image checkout invalid: root=${checkoutRoot}; imageHead=${imageHead}; baseObject=${baseObject.status}`)
    const comparison = compareSourceTrees(
      parseTreeListing(raw('git', ['ls-tree', '-r', '-z', '--full-tree', baseCommit], target)),
      parseTreeListing(raw('git', ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], target)))
    const diff = summarizeRawDiff(parseRawDiff(raw('git', ['diff-tree', '-r', '--raw', '--no-commit-id', baseCommit, 'HEAD'], target)))
    let patchBase = baseCommit
    let environmentCommit: DockerExport['environmentCommit'] = null
    if (!comparison.contentEqual || diff.contentChanges !== 0) {
      const reading = classifyEnvironmentCommit(comparison)
      if (!reading.allowed) {
        throw new Error(`official image content differs from dataset base (${reading.reason ?? 'not build metadata'}): ${describeSourceMismatch({ imageHead, datasetBase: baseCommit, comparison, raw: diff })}`)
      }
      // Keep the image HEAD: it is the tree the official scorer applies the patch to.
      environmentCommit = { imageHead, datasetBase: baseCommit, paths: reading.paths }
      patchBase = imageHead
    } else if (imageHead !== baseCommit) {
      command('git', ['reset', '--hard', baseCommit], target)
    }
    const ignoredImageBuildArtifact = await ignorePinnedImageBuildArtifact(image, target)
    if (command('git', ['status', '--porcelain'], target)) throw new Error('candidate workspace is not clean before the Agent starts')
    return { imageHead, patchBase, environmentCommit,
      evidence: { image, imageHead, baseCommit, patchBase, environmentCommit,
        modeDifferences: comparison.modeDifferences.length, rawContentChanges: diff.contentChanges,
        ignoredImageBuildArtifact } }
  } finally {
    if (exported) removeContainer(exportName)
  }
}

// 与已验收的单题候选 PoC 保持同一组约束：固定 digest、无网络、只读根、单一 /testbed 挂载、
// 非特权、cap drop ALL、宿主 uid/gid。CI 的 Linux runner 才有 uid/gid；Windows 本地没有 Docker 后端。
export async function prepareDockerWorkspace(options: { image: string; baseCommit: string; target: string; exportName: string; containerName: string }): Promise<DockerCandidate> {
  const { image, baseCommit, target, exportName, containerName } = options
  const uid = process.getuid?.(), gid = process.getgid?.()
  if (uid === undefined || gid === undefined) throw new Error('docker backend requires a POSIX uid/gid')
  const exported = await exportDockerWorkspace({ image, baseCommit, target, exportName })
  let started = false, ok = false
  try {
    if (docker('ps', '-aq', '--filter', `name=^/${containerName}$`)) throw new Error(`candidate container already exists: ${containerName}`)
    started = true
    docker('run', '-d', '--name', containerName, '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev',
      '--user', `${uid}:${gid}`, '--env', 'HOME=/tmp/mini-dsh-run',
      '--mount', `type=bind,src=${path.resolve(target)},dst=/testbed`, '--workdir', '/testbed',
      '--env', 'GIT_CONFIG_COUNT=1', '--env', 'GIT_CONFIG_KEY_0=safe.directory', '--env', 'GIT_CONFIG_VALUE_0=/testbed',
      image, 'sh', '-lc', 'mkdir -p /tmp/mini-dsh-run && sleep 86400')
    const container = JSON.parse(docker('inspect', containerName))[0]
    if (container.HostConfig.NetworkMode !== 'none' || container.HostConfig.Privileged !== false || container.HostConfig.ReadonlyRootfs !== true) throw new Error('candidate container isolation flags changed')
    if (container.Config.User !== `${uid}:${gid}`) throw new Error('candidate container user changed')
    if (container.Mounts.length !== 1 || container.Mounts[0].Destination !== '/testbed' || path.resolve(container.Mounts[0].Source) !== path.resolve(target)) throw new Error('candidate container mounts changed')
    docker('exec', containerName, 'sh', '-lc', 'test ! -e /var/run/docker.sock && test ! -e /oracle && test ! -e /reference')
    const evidence = { ...exported.evidence, uid, gid, network: 'none', mounts: ['/testbed'], readonlyRoot: true,
      privileged: false, capDrop: 'ALL' }
    ok = true
    return {
      containerName,
      ...exported,
      cleanup: () => { if (started) { removeContainer(containerName); started = false } },
      evidence,
    }
  } finally {
    if (!ok) {
      if (started) removeContainer(containerName)
    }
  }
}

// Remove only containers carrying one of the runner's labels. mini-SWE-agent
// names its containers randomly and does not clean them after a batch.
export function removeContainersByLabel(label: string): { removed: string[]; remaining: string[] } {
  if (!/^[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]+$/.test(label)) throw new Error('invalid container label filter')
  const ids = docker('ps', '-aq', '--filter', `label=${label}`).split('\n').filter(Boolean)
  if (ids.length) docker('rm', '-f', ...ids)
  const remaining = docker('ps', '-aq', '--filter', `label=${label}`).split('\n').filter(Boolean)
  return { removed: ids, remaining }
}

export function exportPatch(workspace: string, baseCommit: string) {
  execFileSync('git', ['add', '-A'], { cwd: workspace, timeout: 60_000 })
  return raw('git', ['diff', '--cached', '--binary', baseCommit], workspace)
}
