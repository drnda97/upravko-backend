import { describe, expect, it } from 'vitest';
import { chargeReference, fullReference, ipsPayload, isValidAccount, mod97Check, parseReference } from '../src/lib/ips.js';
import { parseStatement } from '../src/routes/budget.js';
import { dueDateFor } from '../src/jobs/index.js';

describe('IPS i poziv na broj', () => {
  it('računa MOD 97-10 tako da provera daje ostatak 1', () => {
    const ref = '072611';
    const check = mod97Check(ref);
    expect(BigInt(`${ref}${check}`) % 97n).toBe(1n);
  });

  it('poziv na broj stana 7 za novembar', () => {
    expect(chargeReference(7, '2026-11')).toBe('072611');
    expect(fullReference('072611')).toMatch(/^97\d{2}072611$/);
    expect(parseReference(`97 ${fullReference('072611').slice(2, 4)}-072611`)).toBe('072611');
    expect(parseReference('9700072611')).toBeNull();
  });

  it('proverava račun od 18 cifara', () => {
    const base = '1600000000012345';
    expect(isValidAccount(`${base}${mod97Check(base)}`)).toBe(true);
    expect(isValidAccount(`${base}00`)).toBe(false);
  });

  it('pravi NBS string sa svim obaveznim poljima', () => {
    const base = '1600000000012345';
    const payload = ipsPayload({ account: `${base}${mod97Check(base)}`, recipient: 'SZ Bulevar | 45', amount: 4000, purpose: 'Rata 2026-11 stan 7', reference: '072611' });
    expect(payload).toMatch(/^K:PR\|V:01\|C:1\|R:\d{18}\|N:SZ Bulevar {3}45\|I:RSD4000,00\|SF:189\|S:Rata 2026-11 stan 7\|RO:97\d{2}072611$/);
  });
});

describe('izvod', () => {
  it('čita CSV sa zaglavljem, tačkom-zarezom i srpskim iznosom', () => {
    const lines = parseStatement('datum;uplatilac;iznos;poziv na broj;svrha\n1. 10. 2026.;"Pera; Perić";4.000,00;;rata');
    expect(lines).toEqual([{ occurredOn: '2026-10-01', payer: 'Pera; Perić', amount: 4000, reference: null, purpose: 'rata' }]);
  });
});

describe('rok zaduženja', () => {
  it('je 15. u mesecu, a posle 15. prelazi na sledeći mesec', () => {
    expect(dueDateFor('2026-11', 1)).toBe('2026-11-15');
    expect(dueDateFor('2026-12', 20)).toBe('2027-01-15');
  });
});
