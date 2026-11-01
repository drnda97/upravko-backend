// NBS IPS QR ("IPS pokaži") i poziv na broj po modelu 97.

/** ISO 7064 MOD 97-10 kontrolni broj (dve cifre). */
export function mod97Check(value: string): string {
  const digits = value.toUpperCase().replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55)).replace(/\D/g, '');
  let remainder = 0;
  for (const d of `${digits}00`) remainder = (remainder * 10 + Number(d)) % 97;
  return String(98 - remainder).padStart(2, '0');
}

export const isValidAccount = (account: string) =>
  /^\d{18}$/.test(account) && mod97Check(account.slice(0, 16)) === account.slice(16);

/** Poziv na broj zaduženja: stan (2+ cifre) + GGMM, npr. stan 7, novembar 2026 = 072611. */
export const chargeReference = (apartmentNumber: number, period: string) =>
  `${String(apartmentNumber).padStart(2, '0')}${period.slice(2, 4)}${period.slice(5, 7)}`;

/** Poziv za uplatu svih dugovanja odjednom: stan + 0000. */
export const allChargesReference = (apartmentNumber: number) => `${String(apartmentNumber).padStart(2, '0')}0000`;

export const fullReference = (reference: string) => `97${mod97Check(reference)}${reference}`;

/** Izvlači poziv iz teksta sa izvoda ("97 15-072611", "9715072611"). */
export function parseReference(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  const withModel = digits.startsWith('97') ? digits.slice(2) : digits;
  if (withModel.length < 8) return null;
  const check = withModel.slice(0, 2);
  const reference = withModel.slice(2);
  return mod97Check(reference) === check ? reference : null;
}

/** IPS zna samo za ćirilicu/latinicu bez separatora; | bi pokvario string. */
const clean = (value: string, max: number) => value.replace(/[|\r\n]/g, ' ').trim().slice(0, max);

export function ipsPayload(p: { account: string; recipient: string; amount: number; purpose: string; reference: string }) {
  const [whole, cents] = p.amount.toFixed(2).split('.');
  return [
    'K:PR',
    'V:01',
    'C:1',
    `R:${p.account}`,
    `N:${clean(p.recipient, 70)}`,
    `I:RSD${whole},${cents}`,
    'SF:189',
    `S:${clean(p.purpose, 35)}`,
    `RO:${fullReference(p.reference)}`,
  ].join('|');
}
