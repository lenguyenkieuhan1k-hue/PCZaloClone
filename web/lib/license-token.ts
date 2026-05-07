import crypto from 'node:crypto'

/* Ed25519-signed license tokens.
 *
 * Token format (compact JWT-like, but custom — keeps deps zero):
 *   base64url(json(payload)) + '.' + base64url(signature)
 *
 * The Electron client validates with the public key embedded at compile
 * time. No JWT library — node:crypto verify(ed25519) is enough.
 *
 * Run once locally to generate a key pair:
 *   node -e "const c=require('crypto'); const {publicKey,privateKey}=c.generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}}); console.log('PUBLIC',publicKey); console.log('PRIVATE',privateKey)"
 * Paste outputs into .env.local as LICENSE_TOKEN_PRIVATE_KEY / LICENSE_TOKEN_PUBLIC_KEY.
 * Embed only the PUBLIC key into the Electron app. */

export interface LicenseTokenPayload {
  sub: string         // license id
  session_id: string
  quota: number       // account quota
  exp: number         // unix seconds
  iat?: number
}

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function fromB64url(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)
  return Buffer.from(padded, 'base64')
}

function getPrivateKey(): crypto.KeyObject {
  const pem = process.env.LICENSE_TOKEN_PRIVATE_KEY
  if (!pem) throw new Error('LICENSE_TOKEN_PRIVATE_KEY not set')
  return crypto.createPrivateKey(pem)
}

function getPublicKey(): crypto.KeyObject {
  const pem = process.env.LICENSE_TOKEN_PUBLIC_KEY
  if (!pem) throw new Error('LICENSE_TOKEN_PUBLIC_KEY not set')
  return crypto.createPublicKey(pem)
}

export async function signLicenseToken(payload: LicenseTokenPayload): Promise<string> {
  const fullPayload = { ...payload, iat: Math.floor(Date.now() / 1000) }
  const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'LIC' }))
  const body = b64url(JSON.stringify(fullPayload))
  const message = Buffer.from(`${header}.${body}`)
  const sig = crypto.sign(null, message, getPrivateKey())
  return `${header}.${body}.${b64url(sig)}`
}

export async function verifyLicenseToken(token: string): Promise<LicenseTokenPayload | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, bodyB64, sigB64] = parts
  const message = Buffer.from(`${headerB64}.${bodyB64}`)
  const sig = fromB64url(sigB64)
  const verified = crypto.verify(null, message, getPublicKey(), sig)
  if (!verified) return null
  try {
    const payload = JSON.parse(fromB64url(bodyB64).toString('utf8')) as LicenseTokenPayload
    if (payload.exp && payload.exp * 1000 < Date.now()) return null
    return payload
  } catch { return null }
}
