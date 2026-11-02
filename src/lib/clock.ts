import { config } from '../config.js';

// Svi poslovni rokovi idu preko ovog sata, da DEMO_NOW i testovi mogu da ga pomere.
// Sa DEMO_NOW sat ide 100 puta sporije: datum stoji, a redosled novih događaja ostaje tačan.
const RATE = config.demoNow ? 0.01 : 1;
let base = config.demoNow ? new Date(config.demoNow).getTime() : Date.now();
let startedAt = Date.now();

export const now = () => new Date(base + (Date.now() - startedAt) * RATE);
export const setNow = (date: Date) => {
  base = date.getTime();
  startedAt = Date.now();
};

const belgrade = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Belgrade',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Datum (YYYY-MM-DD) u zoni Srbije. */
export const localDate = (d: Date = now()) => belgrade.format(d);
export const localPeriod = (d: Date = now()) => localDate(d).slice(0, 7);

/** Postoji li takav dan u kalendaru (odbija 2026-02-30, 2026-13-01). */
export function isIsoDate(s: string) {
  const d = new Date(`${s}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
