const PT = "America/Los_Angeles";

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: PT,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Pacific-time calendar date key, e.g. "2026-10-12" (RPD resets on this boundary). */
export function ptDateKey(d: Date = new Date()): string {
  const p = partsFmt.formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Milliseconds until next midnight Pacific (handles PDT/PST via Intl). */
export function msUntilPtMidnight(d: Date = new Date()): number {
  const p = partsFmt.formatToParts(d);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  const secondsOfDay = get("hour") * 3600 + get("minute") * 60 + get("second");
  const fracMs = d.getMilliseconds();
  return (86_400 - secondsOfDay) * 1000 - fracMs;
}
