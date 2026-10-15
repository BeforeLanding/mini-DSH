export const localDay = (ms, offsetMinutes) => new Date(ms - offsetMinutes * 60_000).toISOString().slice(0, 10)
