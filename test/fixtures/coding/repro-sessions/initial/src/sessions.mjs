// 把一串毫秒时间戳切成会话。完整规则见 docs/SPEC.md。
export function groupSessions(timestamps, gapMs) {
  if (!Array.isArray(timestamps)) throw new Error('timestamps must be an array')
  if (!Number.isSafeInteger(gapMs) || gapMs <= 0) throw new Error('gapMs must be a positive safe integer')
  const sorted = [...timestamps].sort((a, b) => a - b)
  const sessions = []
  for (const at of sorted) {
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('timestamps must be non-negative safe integers')
    const current = sessions.at(-1)
    if (current === undefined || at - current.at(-1) >= gapMs) sessions.push([at])
    else current.push(at)
  }
  return sessions
}
