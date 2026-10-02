import os from 'node:os'
import path from 'node:path'
import { JsonlStore } from '../src/core/event-store.js'

// NX-21：崩溃留下的 writer.lock 此前只能由人手删文件——`JsonlStore.open` 一律拒绝已存在的锁，
// `quarantineTail` 又要先抢同一把锁，而 CLI 的启动恢复在建立 REPL **之前**就抛错
//（src/plugins/cli.ts:38），所以 `/recover` 这类命令在真正需要它的时刻根本不可达。这条入口因此是
// 独立脚本，不是斜杠命令。
//
// 它只把证据摆出来：锁体的 token 与 pid、pid 探针、锁文件时间、events.jsonl 尾部是否完整。**解除与
// 否由操作者判断**，且必须显式给出 `--remove --token <检视里看到的那个 token>`——token 对不上就拒绝，
// 否则删掉的可能是一把刚被新写入者拿到的活锁。pid 只作线索，不替人猜：PLAN 的持久化一节写死了
// 「失效锁显式核验，不仅凭 PID 自动移除」。
const usage = '用法：pnpm session:lock <sessionId> [--remove --token <token>]'
const accepted = new Set(['--remove', '--token'])

function describe(status: 'alive' | 'not-found' | 'inconclusive') {
    return status === 'alive' ? 'alive（本机存在该 pid）' : status === 'not-found' ? 'not-found（本机无此进程）' : 'inconclusive（无法判定）'
}

function describeTail(tail: 'complete' | 'incomplete' | 'missing') {
    return tail === 'complete' ? 'events.jsonl 尾部完整' : tail === 'missing' ? 'events.jsonl 不存在' : 'events.jsonl 尾部有半条记录（销锁后需先隔离再重开）'
}

const abbreviate = (value: string) => value.length <= 12 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`

const argv = process.argv.slice(2)
const positional: string[] = [], unknown: string[] = []
const options = new Map<string, string>()
// `--token` 的取值不是旗标也不是位置参数，所以必须按「谁消费了谁」逐个走，不能用过滤挑出来。
for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) { positional.push(argument); continue }
    const equals = argument.indexOf('=')
    const name = equals === -1 ? argument : argument.slice(0, equals)
    if (!accepted.has(name) || (name === '--remove' && equals !== -1)) { unknown.push(argument); continue }
    if (name === '--remove') { options.set(name, ''); continue }
    const inline = equals === -1 ? undefined : argument.slice(equals + 1)
    const next = inline ?? argv[index + 1]
    // 缺取值记成空串，好与「根本没给 --token」区分开——前者是用法错，后者是「只检视」。
    options.set(name, next !== undefined && (inline !== undefined || !next.startsWith('--')) ? next : '')
    if (inline === undefined && next !== undefined && !next.startsWith('--')) index += 1
}
const remove = options.has('--remove')
const token = options.get('--token')
let exitCode = 0
try {
    if (positional.length !== 1 || unknown.length) throw new Error(unknown.length ? `未知选项：${unknown.join(', ')}` : '必须给出一个 sessionId')
    if (remove !== (token !== undefined)) throw new Error('--remove 与 --token 必须同时出现')
    if (token === '') throw new Error('--token 缺少取值')
    const sessionId = positional[0]
    // 与 src/plugins/cli.ts:32 同一套解析：同一条入口、同一个默认目录。
    const directory = process.env.MINI_DSH_SESSION_DIR ?? path.join(os.homedir(), '.mini-dsh', 'sessions')
    if (remove) {
        await JsonlStore.removeStaleLock(directory, sessionId, token!)
        console.log(`锁已移除：${path.join(directory, sessionId, 'writer.lock')}`)
        console.log('移除只表示这把锁被显式解除，不表示崩溃前的副作用已经核验过——unknown 的结果仍需人核实。')
    } else {
        const inspection = await JsonlStore.inspectLock(directory, sessionId)
        console.log(`目录：${path.join(directory, sessionId)}`)
        console.log(inspection.present ? `锁：存在  mtime=${inspection.modifiedAt}` : '锁：无')
        console.log(`事件：${describeTail(inspection.eventsTail)}`)
        if (!inspection.present) {
            console.log(`没有需要处置的锁，直接恢复：MINI_DSH_SESSION_ID=${sessionId} pnpm start`)
        } else if (!inspection.ownerReadable) {
            console.log('持有者：锁体不可读（不是 {token, pid}）——--token 无从给出，需人工核验后处理')
        } else {
            console.log(`持有者：token=${abbreviate(inspection.token!)} pid=${inspection.pid}`)
            console.log(`pid 探针：${describe(inspection.pidStatus)}`)
            console.log('注意：pid 存活只作线索，pid 复用下不等价于「持有者还在」；确认旧进程与副作用之后再解除。')
            console.log('下一步（确认副作用后可执行）：')
            console.log(`  pnpm session:lock ${sessionId} --remove --token ${inspection.token}`)
        }
    }
} catch (error) {
    exitCode = 1
    console.error(`session:lock 失败：${error instanceof Error ? error.message : String(error)}`)
    console.error(usage)
}
process.exitCode = exitCode
