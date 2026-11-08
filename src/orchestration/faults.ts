// 故障注入只用于离线测试与演示：宿主在命名检查点抛出 SimulatedCrash，
// 编排器把它当作进程崩溃处理——不写报告、不写 root/finish，只关闭文件句柄释放锁。
// 生产路径不传注入器，检查点是空操作。
export type FaultPoint =
  | 'after-root-start'
  | 'before-planning'
  | 'after-plan-decision'
  | 'after-attempt-planned'
  | 'after-attempt-started'
  | 'after-worker-run'
  | 'after-attempt-finished'
  | 'after-integration-started'
  | 'after-cherry-pick'
  | 'before-verification'
  | 'after-verify-command'

export interface FaultInjector { checkpoint(point: FaultPoint): void | Promise<void> }

export class SimulatedCrash extends Error {
  constructor(readonly point: FaultPoint) {
    super(`simulated process crash at ${point}`)
    this.name = 'SimulatedCrash'
  }
}

export const noFaults: FaultInjector = { checkpoint: () => {} }

// 只在指定检查点抛一次；之后的调用（尤其是同一进程里的 resume）正常返回。
export function crashAt(point: FaultPoint): FaultInjector {
  let fired = false
  return {
    checkpoint(current) {
      if (!fired && current === point) { fired = true; throw new SimulatedCrash(current) }
    },
  }
}
