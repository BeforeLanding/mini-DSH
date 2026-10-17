import fs from 'node:fs/promises'
import path from 'node:path'
import { freezeSmokeManifest } from './smoke-manifest.js'

const args = process.argv.slice(2)
if (args.length !== 6 || args[0] !== '--output' || args[2] !== '--scenarios' || args[4] !== '--price-captured-at') throw new Error('usage: smoke-freeze --output NEW_FILE --scenarios repair --price-captured-at ISO_UTC')
const capturedAt = args[5]!
if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(capturedAt) || Number.isNaN(Date.parse(capturedAt))) throw new Error('invalid price timestamp')
const manifest = await freezeSmokeManifest(capturedAt, args[3]!)
const output = path.resolve(args[1]!)
await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify({ manifest: output, digest: manifest.digest, codeSHA: manifest.codeSHA, requests: manifest.scenarios.reduce((sum, item) => sum + item.maxMainRequests + item.maxSummaryRequests, 0), paidRequests: 0 }))
