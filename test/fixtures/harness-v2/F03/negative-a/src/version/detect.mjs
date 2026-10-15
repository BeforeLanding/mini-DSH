export function detect(header) { if (header === 'client,cents') return 'v2'; throw new RangeError('unknown import header') }
