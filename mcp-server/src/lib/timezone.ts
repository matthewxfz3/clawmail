/**
 * Timezone utilities for calendar events using Node.js built-in Intl API.
 * No external libraries — all conversions use Intl.DateTimeFormat.
 */

/**
 * Validate an IANA timezone name. Throws if invalid.
 * Example: "America/Los_Angeles", "Europe/London", "Asia/Tokyo"
 */
export function validateTimezone(tz: string): void {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw new Error(
      `Invalid timezone: "${tz}". Use IANA names like "America/Los_Angeles", "Europe/London", etc.`
    );
  }
}

/**
 * Convert ISO 8601 string to UTC iCal format with Z suffix.
 * Example: "2026-04-05T10:00:00.000Z" → "20260405T100000Z"
 */
export function toICalDateUtc(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * Convert ISO 8601 string to local iCal format (no Z, no offset).
 * Used with TZID parameter: DTSTART;TZID=America/Los_Angeles:20260413T100000
 * Example: "2026-04-13T17:00:00Z" + "America/Los_Angeles" → "20260413T100000"
 */
export function toICalDateLocal(iso: string, tz: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}T${get("hour")}${get(
    "minute"
  )}${get("second")}`;
}

/**
 * Build a minimal VTIMEZONE block for an IANA timezone.
 * Probes January and July to detect standard vs daylight offsets.
 * Returns an array of iCal lines (join with \r\n).
 *
 * Example output:
 * BEGIN:VTIMEZONE
 * TZID:America/Los_Angeles
 * BEGIN:STANDARD
 * TZOFFSETFROM:-0700
 * TZOFFSETTO:-0800
 * RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
 * END:STANDARD
 * BEGIN:DAYLIGHT
 * TZOFFSETFROM:-0800
 * TZOFFSETTO:-0700
 * RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
 * END:DAYLIGHT
 * END:VTIMEZONE
 */
export function buildVTimezone(tzid: string, referenceDate: Date): string[] {
  const lines: string[] = [
    "BEGIN:VTIMEZONE",
    `TZID:${tzid}`,
  ];

  // Probe January (winter) and July (summer) to detect offsets
  const year = referenceDate.getFullYear();
  const janDate = new Date(year, 0, 15); // Jan 15
  const julDate = new Date(year, 6, 15); // Jul 15

  const janOffset = getUtcOffsetMinutes(janDate, tzid);
  const julOffset = getUtcOffsetMinutes(julDate, tzid);

  // Determine which is standard and which is daylight
  const isNorthern = janOffset >= julOffset; // northern hemisphere: winter is standard
  const standardOffset = isNorthern ? janOffset : julOffset;
  const daylightOffset = isNorthern ? julOffset : janOffset;

  // Standard time rule (simplified: November 1st Sunday for US)
  if (standardOffset !== daylightOffset) {
    lines.push("BEGIN:STANDARD");
    lines.push(`TZOFFSETFROM:${offsetToIcal(daylightOffset)}`);
    lines.push(`TZOFFSETTO:${offsetToIcal(standardOffset)}`);
    lines.push("RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU");
    lines.push("END:STANDARD");

    // Daylight time rule (simplified: March 2nd Sunday for US)
    lines.push("BEGIN:DAYLIGHT");
    lines.push(`TZOFFSETFROM:${offsetToIcal(standardOffset)}`);
    lines.push(`TZOFFSETTO:${offsetToIcal(daylightOffset)}`);
    lines.push("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU");
    lines.push("END:DAYLIGHT");
  } else {
    // No DST (fixed offset all year)
    lines.push("BEGIN:STANDARD");
    lines.push(`TZOFFSETFROM:${offsetToIcal(standardOffset)}`);
    lines.push(`TZOFFSETTO:${offsetToIcal(standardOffset)}`);
    lines.push("END:STANDARD");
  }

  lines.push("END:VTIMEZONE");
  return lines;
}

/**
 * Get UTC offset in minutes for a given date and timezone.
 * Positive = ahead of UTC, negative = behind UTC.
 * Example: "America/Los_Angeles" at Jul 15 → -420 (UTC-7)
 */
function getUtcOffsetMinutes(date: Date, tz: string): number {
  // Create a UTC date with same local time components
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);

  // Construct a UTC date from the local parts
  const utcDate = new Date(
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
  );

  // Offset = (local - UTC) in minutes
  return (date.getTime() - utcDate.getTime()) / 60000;
}

/**
 * Convert minutes offset to iCal format: ±HHMM
 * Example: -420 minutes (UTC-7) → "-0700"
 */
function offsetToIcal(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(minutes);
  const hours = Math.floor(absMinutes / 60);
  const mins = absMinutes % 60;
  return `${sign}${String(hours).padStart(2, "0")}${String(mins).padStart(2, "0")}`;
}
