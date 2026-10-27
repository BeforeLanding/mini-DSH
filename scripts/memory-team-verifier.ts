import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

// Independent acceptance for the four public development workflows. The executor
// hands this module a copy of the candidate's final workspace after the candidate
// Harness has exited; it never imports the executor or asks the model for a verdict.
export interface WorkflowDefinition {
  id: string
  category: string
  initialFiles: Record<string, string>
  targetFiles: Record<string, string>
  target: string
  deliverable: { path: string; schema: Record<string, unknown> }
  acceptance: { kind: 'memory-team-objective-v1'; checks: string[] }
}
export interface VerifierCheck { id: string; passed: boolean; detail: string }
export interface VerifierResult {
  passed: boolean
  checks: VerifierCheck[]
  protectedFilesChanged: string[]
  unexpectedFiles: string[]
  answer?: unknown
}

const approvedDeliverable = 'answer.json'
const approvedExtra = new Set(['PREPARE.md'])
const infrastructurePrefixes = ['.mini-dsh/', '.memory-team/']
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const nonempty = (value: unknown, min = 1) => typeof value === 'string' && value.trim().length >= min

async function listFiles(directory: string, relative = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = path.posix.join(relative, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`candidate workspace contains a symlink: ${name}`)
    if (entry.isDirectory()) files.push(...await listFiles(directory, name))
    else if (entry.isFile()) files.push(name)
    else throw new Error(`candidate workspace contains a non-file entry: ${name}`)
  }
  return files
}

function check(id: string, passed: boolean, detail: string): VerifierCheck { return { id, passed, detail } }

export async function verifyMemoryTeamWorkflow(workflow: WorkflowDefinition, workspace: string): Promise<VerifierResult> {
  const checks: VerifierCheck[] = []
  const protectedFilesChanged: string[] = []
  const unexpectedFiles: string[] = []
  let answer: unknown
  try {
    const files = new Set(await listFiles(workspace))
    const allowed = new Set([...Object.keys(workflow.initialFiles), ...Object.keys(workflow.targetFiles), approvedDeliverable, ...approvedExtra])
    for (const file of files) {
      if (allowed.has(file) || infrastructurePrefixes.some(prefix => file.startsWith(prefix))) continue
      unexpectedFiles.push(file)
    }
    checks.push(check('only-allowed-files', unexpectedFiles.length === 0, unexpectedFiles.length ? `unexpected: ${unexpectedFiles.join(', ')}` : 'no unexpected files'))

    for (const [file, content] of Object.entries(workflow.initialFiles)) {
      if (Object.hasOwn(workflow.targetFiles, file)) continue
      const actual = await fs.readFile(path.join(workspace, file), 'utf8')
      if (actual !== content) protectedFilesChanged.push(file)
    }
    checks.push(check('protected-files', protectedFilesChanged.length === 0, protectedFilesChanged.length ? `changed: ${protectedFilesChanged.join(', ')}` : 'initial files unchanged'))

    for (const [file, content] of Object.entries(workflow.targetFiles)) {
      const actual = await fs.readFile(path.join(workspace, file), 'utf8').catch(() => undefined)
      checks.push(check('target-file', actual === content, actual === undefined ? `${file} is missing` : actual === content ? `${file} matches` : `${file} differs from the required version`))
    }

    const raw = await fs.readFile(path.join(workspace, approvedDeliverable), 'utf8').catch(() => undefined)
    try {
      answer = raw === undefined ? undefined : JSON.parse(raw)
    } catch { answer = undefined }
    checks.push(check('answer-json', isRecord(answer), raw === undefined ? `${approvedDeliverable} is missing` : isRecord(answer) ? `${approvedDeliverable} is an object` : `${approvedDeliverable} is not a JSON object`))
    if (!isRecord(answer)) return finish(checks, protectedFilesChanged, unexpectedFiles, answer)

    switch (workflow.id) {
      case 'W01': {
        const exact = isRecord(answer) && exactKeys(answer, ['verificationPath', 'verificationCommand', 'sourcePath']) &&
          answer.verificationPath === 'docs/VERIFY.md' && answer.verificationCommand === 'node check.mjs' && answer.sourcePath === 'src/value.mjs'
        checks.push(check('answer-fields', exact, exact ? 'verification entry and module are correct' : 'verification fields do not match the required values'))
        break
      }
      case 'W02': {
        const exact = exactKeys(answer, ['currentEntry', 'historicalApplicable']) && answer.currentEntry === 'src/new.mjs' && answer.historicalApplicable === false
        checks.push(check('answer-fields', exact, exact ? 'current entry and stale-memory verdict are correct' : 'entry or historical verdict does not match'))
        break
      }
      case 'W03': {
        const modules = Array.isArray(answer.modules) ? answer.modules : []
        const modulesExact = modules.length === 2 && new Set(modules).size === 2 && modules.every(item => typeof item === 'string') &&
          modules.includes('src/parse.mjs') && modules.includes('src/format.mjs')
        const boundaries = isRecord(answer.boundaries) && exactKeys(answer.boundaries, ['parse', 'format']) && nonempty(answer.boundaries.parse, 8) && nonempty(answer.boundaries.format, 8)
        const silent = answer.testsRan === false
        checks.push(check('answer-modules', modulesExact, modulesExact ? 'both modules are identified' : 'module paths are missing or duplicated'))
        checks.push(check('answer-boundaries', boundaries, boundaries ? 'both boundary cases are present' : 'boundary cases are missing or too short'))
        checks.push(check('answer-tests-ran', silent, silent ? 'testsRan is false' : 'the answer claims tests ran'))
        break
      }
      case 'W04': {
        const verdict = answer.nanAccepted === true && answer.historicalHelps === false
        const normalized = typeof answer.smallestCheck === 'string' ? answer.smallestCheck.trim().replace(/^`|`$/g, '').replace(/;$/, '').trim() : ''
        const allowedCheck = ['Number.isNaN(value)', 'value !== value', 'Number.isFinite(value)'].includes(normalized)
        checks.push(check('answer-nan-verdict', verdict, verdict ? 'NaN and historical verdicts are correct' : 'NaN or historical verdict does not match'))
        checks.push(check('answer-smallest-check', allowedCheck, allowedCheck ? 'smallest check is from the allowed set' : 'smallest check is not an allowed expression'))
        break
      }
      default:
        checks.push(check('workflow-known', false, `unknown workflow: ${workflow.id}`))
    }
  } catch (error) {
    checks.push(check('readable-workspace', false, error instanceof Error ? error.message : String(error)))
  }
  return finish(checks, protectedFilesChanged, unexpectedFiles, answer)
}

function finish(checks: VerifierCheck[], protectedFilesChanged: string[], unexpectedFiles: string[], answer: unknown): VerifierResult {
  return { passed: checks.length > 0 && checks.every(item => item.passed), checks, protectedFilesChanged, unexpectedFiles, ...(answer === undefined ? {} : { answer }) }
}

// Used by validate-only: the verifier must reject an untouched blueprint, otherwise
// a broken deliverable could silently pass every episode.
export async function assertVerifierDiscriminates(workflow: WorkflowDefinition, workspace: string) {
  const result = await verifyMemoryTeamWorkflow(workflow, workspace)
  if (result.passed) throw new Error(`verifier accepts an untouched workspace for ${workflow.id}`)
  return result
}

export function workflowDigest(workflow: WorkflowDefinition) {
  return sha256(JSON.stringify({ id: workflow.id, category: workflow.category, initialFiles: workflow.initialFiles, targetFiles: workflow.targetFiles, deliverable: workflow.deliverable, acceptance: workflow.acceptance }))
}
