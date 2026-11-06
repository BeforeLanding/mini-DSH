import { createHash } from 'node:crypto'

// 中性小工具：内容哈希与标识校验。委派与任务组共用，不依赖任何记忆模块。
export const contentHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export const safeId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
export const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const recordObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
