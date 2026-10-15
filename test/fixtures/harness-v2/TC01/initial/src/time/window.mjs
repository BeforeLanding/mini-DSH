export const withinWindow = (now, at) => Number.isFinite(at) && Math.abs(now - at) <= 300_000
