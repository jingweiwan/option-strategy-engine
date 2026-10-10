/**
 * "Which daily close exists yet?" — the US equity session clock.
 *
 * Daily bars are keyed by ET calendar day, but a day's bar only exists once
 * that session has CLOSED and the provider has printed it. Settlement used to
 * compare the UTC date against a window's last day, which calls the window
 * finished at 00:00 UTC — 20:00 ET the evening BEFORE its final session. The
 * scheduler's runs landed at 01Z/04Z/07Z on exactly that day, so the final
 * close was never in the data: on the 2026-09-17 re-settle, 642 outcomes moved
 * and every one of them had been computed on its window-end day before the
 * close. Under the 'user' exit policy the window ends ON the expiration date,
 * so the missing bar is the expiry print itself.
 */
const ET = 'America/New_York'

/** A session counts as settled this many minutes after ET midnight (17:00 =
 *  one hour past the 16:00 close, room for the provider to print the bar). */
export const SESSION_SETTLED_ET_MINUTES = Number(process.env.SESSION_SETTLED_ET_MINUTES) || 17 * 60

let clock: () => Date = () => new Date()

/** Test seam: pin "now". Passing null restores the real clock. */
export function __setNowForTest(fn: (() => Date) | null): void {
  clock = fn ?? (() => new Date())
}

export function currentTime(): Date {
  return clock()
}

export function addCalendarDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

/** Whole calendar days from isoA to isoB (B − A). */
export function calendarDaysBetween(isoA: string, isoB: string): number {
  return Math.round((Date.parse(isoB) - Date.parse(isoA)) / 86_400_000)
}

function etDayAndMinutes(now: Date): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute'))
  }
}

/**
 * Latest ET calendar day whose session has settled. Weekends and holidays need
 * no special case: those days simply have no bar, so "settled" is harmless.
 */
export function lastSettledEtDay(now: Date = currentTime()): string {
  const { day, minutes } = etDayAndMinutes(now)
  return minutes >= SESSION_SETTLED_ET_MINUTES ? day : addCalendarDays(day, -1)
}

/** Saturday/Sunday → the Friday before; weekdays unchanged. Holidays are not
 *  modelled — callers pair this with a grace period instead. */
export function lastWeekdayOnOrBefore(isoDate: string): string {
  const dow = new Date(isoDate + 'T12:00:00Z').getUTCDay()
  if (dow === 6) return addCalendarDays(isoDate, -1)
  if (dow === 0) return addCalendarDays(isoDate, -2)
  return isoDate
}
