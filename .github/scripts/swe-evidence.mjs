import { constants, createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import { createCipheriv, createDecipheriv, createHash, publicEncrypt, privateDecrypt, randomBytes, randomUUID, constants as cryptoConstants } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => JSON.stringify(value, null, 2) + '\n'
const rsaOptions = key => ({ key, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' })

// Only the public key travels to CI. The one-use AES key is RSA wrapped; GCM
// authenticates both the ciphertext and its batch context. Artifact provenance
// is still verified against the GitHub run/commit, not inferred from encryption.
export async function encryptFile(input, publicKey, output, context) {
  const secret = randomBytes(32), nonce = randomBytes(12)
  const normalized = JSON.parse(JSON.stringify(context))
  const cipher = createCipheriv('aes-256-gcm', secret, nonce)
  cipher.setAAD(Buffer.from(JSON.stringify(normalized)))
  const encryptedKey = publicEncrypt(rsaOptions(publicKey), secret)
  const hash = createHash('sha256')
  let handle, complete = false
  try {
    handle = await fs.open(output, 'wx', 0o600)
    const source = createReadStream(input)
    source.on('data', bytes => hash.update(bytes))
    await pipeline(source, cipher, handle.createWriteStream())
    const meta = { schemaVersion: 1, kind: 'swe-encrypted-evidence', algorithm: 'AES-256-GCM+RSA-OAEP-SHA256',
      context: normalized, publicKeySha256: sha(publicKey), encryptedKey: encryptedKey.toString('base64'),
      nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), plaintextSha256: hash.digest('hex') }
    await fs.writeFile(output + '.json', json(meta), { flag: 'wx', mode: 0o600 })
    complete = true
    return meta
  } finally {
    secret.fill(0)
    if (handle) {
      await handle.close().catch(() => {})
      if (!complete) await fs.rm(output, { force: true })
    }
  }
}

export async function decryptFile(input, metadata, privateKey, output) {
  if (metadata.schemaVersion !== 1 || metadata.kind !== 'swe-encrypted-evidence' || metadata.algorithm !== 'AES-256-GCM+RSA-OAEP-SHA256'
    || !/^[a-f0-9]{64}$/.test(metadata.plaintextSha256)) throw new Error('unsupported encrypted evidence')
  const secret = privateDecrypt(rsaOptions(privateKey), Buffer.from(metadata.encryptedKey, 'base64'))
  const nonce = Buffer.from(metadata.nonce, 'base64'), tag = Buffer.from(metadata.tag, 'base64')
  if (secret.length !== 32 || nonce.length !== 12 || tag.length !== 16) { secret.fill(0); throw new Error('invalid encryption parameters') }
  const decipher = createDecipheriv('aes-256-gcm', secret, nonce)
  decipher.setAAD(Buffer.from(JSON.stringify(metadata.context)))
  decipher.setAuthTag(tag)
  const temporary = `${output}.partial-${randomUUID()}`
  const hash = createHash('sha256')
  decipher.on('data', bytes => hash.update(bytes))
  try {
    await pipeline(createReadStream(input), decipher, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
    if (hash.digest('hex') !== metadata.plaintextSha256) throw new Error('decrypted archive hash mismatch')
    // No plaintext is promoted until the authentication tag and hash pass;
    // existing output is never overwritten, even after successful decryption.
    await fs.copyFile(temporary, output, constants.COPYFILE_EXCL)
    return { decrypted: true, plaintextSha256: metadata.plaintextSha256, context: metadata.context }
  } finally { secret.fill(0); await fs.rm(temporary, { force: true }) }
}

function argument(name) {
  const index = process.argv.indexOf(name), value = index < 0 ? undefined : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`)
  return value
}

async function main() {
  if (process.argv[2] === 'encrypt') {
    const meta = await encryptFile(argument('--input'), await fs.readFile(argument('--public-key'), 'utf8'), argument('--output'),
      JSON.parse(await fs.readFile(argument('--context'), 'utf8')))
    console.log(JSON.stringify({ encrypted: true, publicKeySha256: meta.publicKeySha256, context: meta.context }))
  } else if (process.argv[2] === 'decrypt') {
    const result = await decryptFile(argument('--input'), JSON.parse(await fs.readFile(argument('--metadata'), 'utf8')),
      await fs.readFile(argument('--private-key'), 'utf8'), argument('--output'))
    console.log(JSON.stringify(result))
  } else throw new Error('choose encrypt or decrypt')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
