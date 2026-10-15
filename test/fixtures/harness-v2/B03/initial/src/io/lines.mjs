export const nonemptyLines = text => text.split(/\r?\n/).filter(line => line.trim().length > 0)
