// 校验和的口径不在本仓库内（见 docs/SPEC.md 第 4 节）。这里先返回 0，让第 3 阶段的渲染与公开检查
// 能跑起来，数值等排期说明给出后再补上。
export function checksum(entries) {
  return 0
}
