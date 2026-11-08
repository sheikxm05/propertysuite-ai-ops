/**
 * Presentation helpers for tenancy and tenant surfaces. Pure, and locale-pinned.
 *
 * `DEFAULT_LOCALE` and `DEFAULT_CURRENCY` come from `packages/shared/constants/locale`
 * (`en-AE`, `AED`, frozen in §5.7) rather than from the browser. A rent figure rendered
 * in the visitor's locale would show a Dubai lease in US dollars to a US visitor, which
 * is not a formatting nicety but a wrong number on a contract screen.
 *
 * `formatMoney` takes the canonical decimal **string** that `MoneyAmountSchema`
 * produces and parses it only at the last moment, for display. That is the one place a
 * monetary value is allowed to become a float: no arithmetic happens afterwards.
 */

import { DEFAULT_CURRENCY, DEFAULT_LOCALE, type TenancyStatus } from '@shared/index';

/** `"120000.00"`, `"AED"` → `"AED 120,000.00"`. */
export function formatMoney(amount: string, currency: string = DEFAULT_CURRENCY): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return `${currency} ${amount}`;

  try {
    return new Intl.NumberFormat(DEFAULT_LOCALE, {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // An unknown ISO code throws rather than falling back, and a tenancy screen that
    // renders nothing is worse than one that renders the code verbatim.
    return `${currency} ${amount}`;
  }
}

/** `"2026-11-09"` → `"9 Nov 2026"`. Invalid input is passed through unchanged. */
export function formatDate(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;

  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

/** Whole days from `from` to `to`, negative when `to` is in the past. */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

/** Badge variant per lifecycle state. Semantic names only — no colours at a call site. */
export function tenancyStatusTone(
  status: TenancyStatus,
): 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline' {
  switch (status) {
    case 'active':
      return 'success';
    case 'draft':
      return 'secondary';
    case 'expired':
      return 'warning';
    case 'terminated':
      return 'destructive';
  }
}

/** Human label for a lifecycle state. */
export function tenancyStatusLabel(status: TenancyStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
