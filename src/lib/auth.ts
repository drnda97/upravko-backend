import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { exec, one, pool, uuid, type Db } from '../db.js';
import { ApiError } from './errors.js';

const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_MS = 60 * 24 * 3600 * 1000;
const REPLAY_GRACE_MS = 30_000;

export const hashPassword = (password: string) => bcrypt.hash(password, 10);
export const checkPassword = (password: string, hash: string) => bcrypt.compare(password, hash);
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');

export const signAccess = (userId: string) => jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: ACCESS_TTL_S });

export function verifyAccess(token: string): string {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub: string };
    return payload.sub;
  } catch {
    throw new ApiError(401, 'unauthorized', 'Sesija je istekla. Prijavite se ponovo.');
  }
}

export async function issueTokens(db: Db, userId: string) {
  const refreshToken = randomToken();
  await exec(
    db,
    'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    [uuid(), userId, sha256(refreshToken), new Date(Date.now() + REFRESH_TTL_MS), new Date()],
  );
  return { accessToken: signAccess(userId), refreshToken };
}

/** Rotacija: stari refresh token se poništava pri svakoj upotrebi. */
export async function rotateRefresh(token: string) {
  const row = await one(pool, 'SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?', [sha256(token)]);
  // Kratka tolerancija: ako se odgovor izgubio na mreži, klijent sme da ponovi isti token.
  const replayed = row?.revoked_at && Date.now() - row.revoked_at.getTime() > REPLAY_GRACE_MS;
  if (!row || replayed || row.expires_at < new Date()) {
    throw new ApiError(401, 'unauthorized', 'Sesija je istekla. Prijavite se ponovo.');
  }
  if (!row.revoked_at) await exec(pool, 'UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', [new Date(), row.id]);
  return issueTokens(pool, row.user_id);
}

export const revokeRefresh = (token: string) => exec(pool, 'DELETE FROM refresh_tokens WHERE token_hash = ?', [sha256(token)]);

export function userId(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new ApiError(401, 'unauthorized', 'Prijavite se.');
  return verifyAccess(header.slice(7));
}
