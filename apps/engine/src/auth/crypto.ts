/**
 * Password hashing (scrypt) and session tokens (HS256 JWT), with node:crypto
 * only. Secrets and passwords are never logged.
 */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) =>
      err ? reject(err) : resolve(key),
    )
  })
}

/** `scrypt$<salt b64>$<key b64>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt)
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, key] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !key) return false
  const expected = Buffer.from(key, 'base64')
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Constant time, any lengths. */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

/**
 * The set-password token of one link: HMAC(secret, user id + expiry). Not
 * stored (the row keeps only its sha256), yet the engine can show an open link
 * again; a new link (new expiry) or another SKILLLANE_MONITORING_AUTH_SECRET gives another token.
 */
export const inviteToken = (secret: string, userId: string, expiresAt: string): string =>
  createHmac('sha256', secret).update(`invite:${userId}:${expiresAt}`).digest('base64url')

export interface SessionClaims {
  /** User id, or ENV_ADMIN_ID. */
  sub: string
  /** token_version of the user (env admin: a hash of its credentials). */
  ver: string
  iat: number
  exp: number
}

const b64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
const HEADER = b64({ alg: 'HS256', typ: 'JWT' })

export function signSession(claims: SessionClaims, secret: string): string {
  const body = `${HEADER}.${b64(claims)}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

/** The claims when the signature is right and it has not expired; else undefined. */
export function verifySession(token: string, secret: string, nowS = Math.floor(Date.now() / 1000)): SessionClaims | undefined {
  const [header, payload, signature] = token.split('.')
  if (header !== HEADER || !payload || !signature) return undefined
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest()
  const given = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims
    if (typeof claims.sub !== 'string' || typeof claims.ver !== 'string' || typeof claims.exp !== 'number') return undefined
    return claims.exp > nowS ? claims : undefined
  } catch {
    return undefined
  }
}
