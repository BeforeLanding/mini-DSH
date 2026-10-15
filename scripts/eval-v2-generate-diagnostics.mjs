import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../test/fixtures/harness-v2/', import.meta.url))

function u03() {
  const records = []
  for (let index = 0; index < 260; index += 1) {
    const id = `req-${String(10000 + index)}`
    const zone = index % 3 === 0 ? 'B' : 'A'
    const base = 500 + (index * 73) % 5000
    const coupon = index % 4 === 0 ? Math.round(base / 5) : 0
    const net = base - coupon
    const shipping = index % 5 === 0 ? 125 : 0
    const observedTax = Math.round(base * (zone === 'B' ? 0.05 : 0.10))
    const settledTax = Math.round(net * (zone === 'B' ? 0.05 : 0.10))
    records.push({ at: index * 4, requestId: id, stage: 'intake', zone, itemBaseCents: base, couponCents: coupon })
    records.push({ at: index * 4 + 1, requestId: id, stage: 'subtotal', netCents: net, shippingCents: shipping })
    records.push({ at: index * 4 + 2, requestId: id, stage: 'tax', observedTaxCents: observedTax, taxableBaseCents: base })
    records.push({ at: index * 4 + 3, requestId: id, stage: 'settlement', settledTaxCents: settledTax, settledTotalCents: net + settledTax + shipping })
  }
  // Interleave requests deterministically so a single adjacent log slice does not hand out a complete trace.
  records.sort((a, b) => (a.at % 17) - (b.at % 17) || a.at - b.at)
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

function b03() {
  const records = []
  for (let batch = 0; batch < 120; batch += 1) {
    const name = `batch-${String(batch).padStart(3, '0')}`
    let net = 0
    for (let entry = 0; entry < 5; entry += 1) {
      const amountCents = entry === 3 && batch % 3 === 0 ? -(50 + batch) : 100 + (batch * 17 + entry * 11) % 600
      net += amountCents
      records.push({ batch: name, sequence: entry, kind: amountCents < 0 ? 'refund' : 'sale', amountCents })
    }
    records.push({ batch: name, stage: 'settlement', settledNetCents: net })
  }
  records.sort((a, b) => ((a.sequence ?? 5) * 19 + Number(a.batch.slice(-3))) % 23 - ((b.sequence ?? 5) * 19 + Number(b.batch.slice(-3))) % 23 || a.batch.localeCompare(b.batch))
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

function f03() {
  const records = []
  for (let file = 0; file < 350; file += 1) {
    const version = file % 4 === 0 ? 'v1' : 'v2'
    const cents = 29 + file * 7
    records.push({ fileId: `import-${String(file).padStart(4, '0')}`, version, header: version === 'v1' ? 'customer,total' : 'client,cents', sampleAmount: version === 'v1' ? `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}` : String(cents), status: version === 'v1' ? 'unsupported-in-current-importer' : 'imported' })
  }
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

function t03() {
  const records = []
  for (let index = 0; index < 900; index += 1) {
    const tenant = index % 2 ? 'south' : 'north'
    const id = `alert-${String(index % 45).padStart(3, '0')}`
    records.push({ received: index, tenant, id, at: Math.floor(index / 45), severity: ['low', 'medium', 'high'][index % 3] })
  }
  records.sort((a, b) => (a.received % 29) - (b.received % 29) || a.received - b.received)
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

function r03() {
  const records = []
  for (let index = 0; index < 320; index += 1) {
    const market = index % 2 ? 'international' : 'domestic'
    const maxWeight = market === 'domestic' ? 20 : 10
    const order = { weightKg: index % 7 === 0 ? maxWeight + 1 : 1 + index % maxWeight, longestCm: index % 11 === 0 ? 101 : 10 + index % 90, ...(market === 'domestic' ? { postcode: index % 13 === 0 ? '' : '12345' } : { customsCode: index % 13 === 0 ? '' : 'X1' }) }
    const reason = order.weightKg > maxWeight ? 'weight' : order.longestCm > 100 ? 'dimensions' : index % 13 === 0 ? market === 'domestic' ? 'postcode' : 'customs' : null
    records.push({ caseId: `case-${String(index).padStart(4, '0')}`, market, order, expectedReason: reason })
  }
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

function bc01() {
  const rows = []
  for (let index = 0; index < 360; index += 1) {
    const at = new Date(Date.UTC(2024, 0, 1 + Math.floor(index / 24), index % 24, 30)).toISOString()
    const offsetMinutes = [-480, -120, 0, 120, 330][index % 5]
    rows.push({ eventId: `evt-${index}`, at, offsetMinutes, expectedLocalDay: new Date(Date.parse(at) + offsetMinutes * 60_000).toISOString().slice(0, 10) })
  }
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n'
}

function fc01() {
  const rows = []
  for (let index = 0; index < 320; index += 1) {
    const feature = `feature-${index % 24}`
    const prerequisite = `platform-${index % 7}`
    const prerequisiteEnabled = index % 6 !== 0
    rows.push({ deployment: `rollout-${String(index).padStart(4, '0')}`, feature, ownFlag: true, requires: [prerequisite], prerequisiteEnabled, observedDirectOnly: true, expectedWithDependencies: prerequisiteEnabled })
  }
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n'
}

function tc01() {
  const rows = []
  for (let index = 0; index < 360; index += 1) {
    const id = `hook-${String(Math.floor(index / 3)).padStart(4, '0')}`
    const attempt = index % 3
    rows.push({ received: index, id, at: 1_000_000 + Math.floor(index / 3) * 1000 + (attempt === 2 ? 400_000 : 0), signatureState: attempt === 1 ? 'same-valid-signature' : attempt === 2 ? 'valid-but-expired' : 'valid', expectedAccepted: attempt === 0 })
  }
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n'
}

for (const [id, filename, content] of [
  ['U03', 'incident.ndjson', u03()], ['B03', 'batches.ndjson', b03()],
  ['F03', 'imports.ndjson', f03()], ['R03', 'regressions.ndjson', r03()], ['T03', 'incident.ndjson', t03()],
  ['BC01', 'events.ndjson', bc01()], ['FC01', 'decisions.ndjson', fc01()], ['TC01', 'webhooks.ndjson', tc01()],
]) {
  const directory = path.join(root, id, 'initial', id === 'R03' ? 'cases' : 'logs')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, filename), content)
}
