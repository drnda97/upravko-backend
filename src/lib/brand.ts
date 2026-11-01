import type { Row } from '../db.js';

/** Brend tokeni organizacije: jedini izvor white-label boja za sve klijente. */
export const brandOf = (o: Row) => ({
  name: o.name,
  logoVariant: o.logo_variant,
  logoUrl: o.logo_url,
  primary: o.color_primary,
  primaryDark: o.color_primary_dark,
  secondary: o.color_secondary,
  accent: o.color_accent,
});
