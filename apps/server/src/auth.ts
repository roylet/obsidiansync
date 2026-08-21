import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { MetaDb, TokenRow } from './db.js';

const scryptAsync = promisify(scrypt);

const KEY_LENGTH = 32;
/** Tokens are 32 random bytes; base64url keeps them copy-pasteable on a phone. */
const TOKEN_BYTES = 32;

export interface MintedToken {
  id: string;
  name: string;
  /** Shown once at creation and never recoverable afterwards. */
  token: string;
}

async function derive(token: string, salt: string): Promise<Buffer> {
  return (await scryptAsync(token, salt, KEY_LENGTH)) as Buffer;
}

export function generateTokenValue(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Create a token and store only its scrypt hash, so a leaked copy of `meta.db`
 * does not hand over vault access.
 */
export async function mintToken(db: MetaDb, name: string, value?: string): Promise<MintedToken> {
  const token = value ?? generateTokenValue();
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(token, salt)).toString('hex');
  const id = randomUUID();
  db.insertToken({ id, name, hash, salt, created: Date.now(), last_seen: null });
  return { id, name, token };
}

/**
 * Find the token record matching `presented`, or undefined.
 *
 * Every candidate is checked with a constant-time comparison. The linear scan
 * is fine: this is a personal server with a handful of devices, and scrypt
 * dominates the cost anyway.
 */
export async function verifyToken(db: MetaDb, presented: string): Promise<TokenRow | undefined> {
  if (typeof presented !== 'string' || presented.length === 0) return undefined;
  for (const row of db.listTokens()) {
    const candidate = await derive(presented, row.salt);
    const stored = Buffer.from(row.hash, 'hex');
    if (candidate.length === stored.length && timingSafeEqual(candidate, stored)) {
      return row;
    }
  }
  return undefined;
}

export function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Throttles repeated authentication failures from one address.
 *
 * The server is reachable from the public internet through the tunnel, so an
 * unauthenticated endpoint that runs scrypt on demand is both a guessing
 * oracle and a CPU amplification lever. After `maxFailures` bad tokens an
 * address is refused outright for `windowMs` without the hash being computed.
 */
export class AuthThrottle {
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  isBlocked(key: string): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (this.now() > entry.until) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= this.maxFailures;
  }

  recordFailure(key: string): void {
    const now = this.now();
    const entry = this.failures.get(key);
    if (!entry || now > entry.until) {
      this.failures.set(key, { count: 1, until: now + this.windowMs });
      return;
    }
    entry.count += 1;
    entry.until = now + this.windowMs;
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }
}
