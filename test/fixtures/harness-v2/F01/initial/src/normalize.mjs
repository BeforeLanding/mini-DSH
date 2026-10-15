export const normalizeWords = input => String(input).normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/gu, ' ')
