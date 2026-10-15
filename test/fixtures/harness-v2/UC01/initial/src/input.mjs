export const normalize = raw => ({ localRev: String(raw.localRev), remoteRev: String(raw.remoteRev), remoteDeleted: raw.remoteDeleted === true })
