import { createHash } from 'node:crypto'

export interface DiagnosticVariant { bytes: 4096 | 262144; repeat: 0 | 1 | 2 }

export function diagnosticValue(repeat: DiagnosticVariant['repeat']): string {
  return createHash('sha256').update(`NX-51/BC01/diagnostic/${repeat}`).digest('hex').slice(0, 20)
}

export function diagnosticLog(variant: DiagnosticVariant): string {
  const offset = variant.bytes / 2
  const header = `DIAGNOSTIC_OFFSET=${offset}\n`
  const marker = `DIAGNOSTIC_VALUE=${diagnosticValue(variant.repeat)}\n`
  return header + 'x'.repeat(offset - header.length) + marker + 'y'.repeat(variant.bytes - offset - marker.length)
}

// The value is computed when the candidate runs the script; the public task gives only its command.
export function diagnosticScript(variant: DiagnosticVariant): string {
  return `import { createHash } from 'node:crypto'\nconst bytes = ${variant.bytes}, repeat = ${variant.repeat}\nconst offset = bytes / 2\nconst header = \`DIAGNOSTIC_OFFSET=\${offset}\\n\`\nconst value = createHash('sha256').update(\`NX-51/BC01/diagnostic/\${repeat}\`).digest('hex').slice(0, 20)\nconst marker = \`DIAGNOSTIC_VALUE=\${value}\\n\`\nprocess.stdout.write(header + 'x'.repeat(offset - header.length) + marker + 'y'.repeat(bytes - offset - marker.length))\n`
}

export function diagnosticTask(base: string): string {
  return `${base}\n\nNX-51 开发诊断：开始修改前必须通过 bash 运行 \`node diagnostic.mjs\`。诊断输出头部给出 DIAGNOSTIC_OFFSET（UTF-8 字节偏移）；如工具只显示预览，请用 read_tool_result 按需回读中部。完成原业务任务后，在最终答复写成 \`DIAGNOSTIC_VALUE=<日志中的值>\`。不要根据脚本源码推算该值；以实际运行输出为准。\n`
}
