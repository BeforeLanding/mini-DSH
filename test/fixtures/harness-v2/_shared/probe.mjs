import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createIsolatedCommandRunner } from '../../../../dist/scripts/eval-v2-isolation.js'

export async function runCandidate(workspace, command) {
  const runtimeRoot = process.env.V2_RUNTIME_ROOT, distro = process.env.V2_DISTRO
  if (!runtimeRoot || !distro) throw new Error('hidden acceptance requires isolated candidate runtime')
  const runner = createIsolatedCommandRunner({ workspace, runtimeRoot, distro })
  return runner({ executable: 'ignored', args: [], command, cwd: workspace, signal: new AbortController().signal, timeoutMs: 10_000, maxCaptureBytes: 64 * 1024 })
}

export async function withVariant(candidate, variant, work) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-v2-variant-'))
  const workspace = path.join(directory, 'workspace')
  try {
    await fs.cp(candidate, workspace, { recursive: true, errorOnExist: true })
    if (variant) {
      async function overlay(source, prefix = '') {
        for (const entry of await fs.readdir(source, { withFileTypes: true })) {
          const name = path.join(prefix, entry.name), target = path.join(workspace, name)
          if (entry.isDirectory()) await overlay(path.join(source, entry.name), name)
          else if (entry.isFile()) {
            await fs.mkdir(path.dirname(target), { recursive: true })
            await fs.copyFile(path.join(source, entry.name), target)
          } else throw new Error(`unsupported hidden variant entry: ${entry.name}`)
        }
      }
      await overlay(variant)
    }
    return await work(workspace)
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
}

export async function reportGroups(report, definitions) {
  const groups = []
  for (const [name, check] of definitions) {
    try { await check(); groups.push({ name, passed: true }) }
    catch (error) { groups.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) }) }
  }
  await fs.writeFile(report, JSON.stringify(groups))
  if (groups.some(group => !group.passed)) process.exitCode = 1
}

export function expectExit(result, code) {
  assert.equal(result.status, 'exited', result.stderr.text)
  assert.equal(result.exitCode, code, `${result.stdout.text}\n${result.stderr.text}`)
}

export async function invokeCases(workspace, modulePath, exportName, argumentLists, freezeInputs = false) {
  if (!/^\.\/src\/[A-Za-z0-9/_-]+\.mjs$/.test(modulePath) || !/^[A-Za-z][A-Za-z0-9]*$/.test(exportName)) throw new Error('invalid hidden invocation target')
  const encoded = Buffer.from(JSON.stringify(argumentLists)).toString('base64')
  const code = `const m = await import(${JSON.stringify(modulePath)}); const cases = JSON.parse(Buffer.from('${encoded}', 'base64')); const out = []; const freeze = x => { if (x && typeof x === 'object') { for (const value of Object.values(x)) freeze(value); Object.freeze(x) } }; for (const args of cases) { if (${freezeInputs}) for (const arg of args) freeze(arg); try { out.push({ ok: true, value: await m.${exportName}(...args) }) } catch (error) { out.push({ ok: false, name: error?.name, message: error?.message }) } } console.log('__V2_RESULT__' + JSON.stringify(out));`
  const quoted = `'${code.replaceAll("'", "'\\''")}'`
  const result = await runCandidate(workspace, `node --input-type=module -e ${quoted}`)
  assert.equal(result.status, 'exited', result.stderr.text)
  assert.equal(result.exitCode, 0, result.stderr.text)
  const line = result.stdout.text.split(/\r?\n/).findLast(value => value.startsWith('__V2_RESULT__'))
  if (!line) throw new Error(`candidate returned no structured result: ${result.stdout.text}`)
  return JSON.parse(line.slice('__V2_RESULT__'.length))
}

export async function executeScenario(workspace, code) {
  const quoted = `'${code.replaceAll("'", "'\\''")}'`
  const result = await runCandidate(workspace, `node --input-type=module -e ${quoted}`)
  assert.equal(result.status, 'exited', result.stderr.text)
  assert.equal(result.exitCode, 0, result.stderr.text)
  const line = result.stdout.text.split(/\r?\n/).findLast(value => value.startsWith('__V2_RESULT__'))
  if (!line) throw new Error(`scenario returned no structured result: ${result.stdout.text}`)
  return JSON.parse(line.slice('__V2_RESULT__'.length))
}
