// cross-spawn 7.x 没有自带类型；这里只声明启动器用到的 spawn 形态。
declare module 'cross-spawn' {
  import type { ChildProcess, SpawnOptions } from 'node:child_process'
  export default function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess
}
