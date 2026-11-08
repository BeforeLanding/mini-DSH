import fs from 'node:fs/promises'

// 读取证据文件，超过上限即拒绝；多读 1 字节用于发现超长。
export async function readBoundedFile(target: string, maxBytes: number) {
  const file = await fs.open(target, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('evidence exceeds file limit')
    const buffer = Buffer.alloc(maxBytes + 1)
    let total = 0
    while (total < buffer.length) { const { bytesRead } = await file.read(buffer, total, buffer.length - total, null); if (!bytesRead) break; total += bytesRead }
    if (total > maxBytes) throw new Error('evidence exceeds file limit')
    return buffer.subarray(0, total)
  } finally { await file.close() }
}
