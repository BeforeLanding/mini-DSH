export const withinWindow = (now, at) => Number.isFinite(at) && Math.abs(now - at) <= 600_000
