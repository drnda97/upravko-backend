import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { exec, one, uuid, type Db } from '../db.js';
import { badRequest } from './errors.js';

export const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

/** Tip se proverava po sadržaju fajla, ne po onome što je klijent poslao kao MIME. */
export function contentMatches(mime: string, data: Buffer) {
  const at = (offset: number, text: string) => data.subarray(offset, offset + text.length).toString('latin1') === text;
  switch (mime) {
    case 'image/jpeg': return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case 'image/png': return at(0, '\x89PNG\r\n\x1a\n');
    case 'image/webp': return at(0, 'RIFF') && at(8, 'WEBP');
    case 'image/heic': return at(4, 'ftyp');
    case 'application/pdf': return at(0, '%PDF-');
    default: return false;
  }
}

const URL_TTL_S = 7 * 24 * 3600;
const sign = (name: string, exp: number) =>
  createHmac('sha256', config.jwtSecret).update(`${name}.${exp}`).digest('base64url');

/** Fajlovi su privatni; API izdaje potpisan link samo onome ko sme da vidi zapis. */
export function signedUrl(name: string | null | undefined): string | null {
  if (!name) return null;
  // Rok je zaokružen na dan, pa link ostaje isti i slika se ne preuzima ponovo.
  const day = 24 * 3600;
  const exp = Math.ceil((Date.now() / 1000 + URL_TTL_S) / day) * day;
  return `${config.publicUrl}/files/${encodeURIComponent(name)}?exp=${exp}&sig=${sign(name, exp)}`;
}

export function verifySignature(name: string, exp: number, sig: string) {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(name, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function saveFile(db: Db, opts: { data: Buffer; mime: string; originalName: string; uploadedBy: string | null }) {
  const ext = ALLOWED_MIME[opts.mime];
  if (!ext) throw badRequest('bad_file', 'Dozvoljene su slike i PDF.');
  const name = `${uuid()}.${ext}`;
  await fs.mkdir(config.storageDir, { recursive: true });
  await fs.writeFile(path.join(config.storageDir, name), opts.data);
  await exec(db, 'INSERT INTO uploads (path, uploaded_by, original_name, mime, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    name, opts.uploadedBy, opts.originalName.slice(0, 255), opts.mime, opts.data.length, new Date(),
  ]);
  return name;
}

/** Klijent sme da zakači samo fajl koji je sam otpremio. */
export async function assertOwnUpload(db: Db, userId: string, name: string | null | undefined) {
  if (!name) return;
  const row = await one(db, 'SELECT 1 AS ok FROM uploads WHERE path = ? AND uploaded_by = ?', [name, userId]);
  if (!row) throw badRequest('bad_file', 'Fajl nije pronađen. Otpremite ga ponovo.');
}

export async function fileInfo(db: Db, name: string | null | undefined) {
  if (!name) return null;
  const row = await one(db, 'SELECT original_name, mime, size_bytes FROM uploads WHERE path = ?', [name]);
  return { url: signedUrl(name), name: row?.original_name ?? name, mime: row?.mime ?? null, sizeBytes: row?.size_bytes ?? null };
}
