/**
 * Business hours, as a pure function of an instant.
 *
 * `resolvePriority()` in `packages/shared` takes `outsideBusinessHours` as a trusted
 * input and deliberately does not read the clock itself ("the caller reads the clock").
 * This module is that caller's clock reader, kept separate from the service so the
 * policy stays testable without faking timers.
 *
 * Dubai specifics, and why they are hard-coded rather than configurable:
 *
 *  - The UAE observes no daylight saving, so Gulf Standard Time is a fixed `UTC+4`
 *    offset all year. A fixed offset is therefore correct, not an approximation, and
 *    it avoids depending on the host's IANA database.
 *  - The UAE working week has been Monday to Friday since January 2022.
 *  - `config/**` is owned by another lane and is a nav/widget registry, not a settings
 *    store, so there is nowhere in this build these values legitimately belong except
 *    here. If they ever need to vary per organization that is a schema change and a
 *    planning decision, not a constant to quietly make into an env var.
 *
 * The only consequence of this function is at most one step of priority escalation on
 * a safety-sensitive category in an occupied unit (see `resolvePriority`), so a wrong
 * answer at the boundary minute is a nuisance, never an authorization decision.
 */

/** Fixed Gulf Standard Time offset, in hours. The UAE has no daylight saving. */
export const GULF_STANDARD_TIME_OFFSET_HOURS = 4;

/** First and last working hour, inclusive of the open hour, exclusive of the close. */
export const BUSINESS_HOUR_OPEN = 8;
export const BUSINESS_HOUR_CLOSE = 18;

/** Monday (1) to Friday (5), matching `Date.prototype.getUTCDay()` numbering. */
export const BUSINESS_DAYS: readonly number[] = [1, 2, 3, 4, 5];

/** The instant, expressed in Gulf Standard Time. */
export interface LocalInstant {
  /** `0` Sunday through `6` Saturday. */
  weekday: number;
  /** `0` to `23`. */
  hour: number;
}

/**
 * Converts an instant to its Gulf Standard Time wall-clock weekday and hour.
 *
 * Shifting the epoch milliseconds and then reading the UTC fields is the whole trick:
 * it never consults the host time zone, so the result is identical on a developer
 * laptop in Dubai and on a CI runner in UTC.
 */
export function toGulfStandardTime(instant: Date): LocalInstant {
  const shifted = new Date(instant.getTime() + GULF_STANDARD_TIME_OFFSET_HOURS * 3_600_000);
  return { weekday: shifted.getUTCDay(), hour: shifted.getUTCHours() };
}

/** Is `instant` inside Monday–Friday, 08:00–18:00 Gulf Standard Time? */
export function isWithinBusinessHours(instant: Date): boolean {
  const { weekday, hour } = toGulfStandardTime(instant);
  if (!BUSINESS_DAYS.includes(weekday)) return false;
  return hour >= BUSINESS_HOUR_OPEN && hour < BUSINESS_HOUR_CLOSE;
}

/** The value `resolvePriority()`'s `outsideBusinessHours` context field expects. */
export function isOutsideBusinessHours(instant: Date): boolean {
  return !isWithinBusinessHours(instant);
}
