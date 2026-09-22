/** Minutes-since-midnight helpers + departure math for frequency/custom timetables. */

export function parseTimeToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Parse + validate a custom departure list, sorted ascending, de-duplicated. */
export function normalizeCustomDepartures(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  const out = new Set<number>();
  for (const v of values) {
    if (typeof v !== "string") continue;
    const mins = parseTimeToMinutes(v);
    if (mins !== null) out.add(mins);
  }
  return [...out].sort((a, b) => a - b);
}

/** Format minutes-since-midnight back to "HH:MM". */
export function formatMinutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

export function formatClock(date: Date): string {
  const h = date.getHours().toString().padStart(2, "0");
  const min = date.getMinutes().toString().padStart(2, "0");
  return `${h}:${min}`;
}

/** Next departure strictly after... actually at-or-after `from`. */
export function nextDeparture(
  from: Date,
  firstDeparture: string,
  frequencyMinutes: number,
): Date | null {
  const anchor = parseTimeToMinutes(firstDeparture);
  const freq = Math.floor(Number(frequencyMinutes));
  if (anchor === null || !Number.isFinite(freq) || freq <= 0) return null;

  const midnight = new Date(from);
  midnight.setHours(0, 0, 0, 0);
  const anchorDate = new Date(midnight.getTime() + anchor * 60_000);

  if (from.getTime() <= anchorDate.getTime()) return anchorDate;

  const diffMs = from.getTime() - anchorDate.getTime();
  const k = Math.ceil(diffMs / (freq * 60_000));
  return new Date(anchorDate.getTime() + k * freq * 60_000);
}

/** Next departure at-or-after `from` from an explicit daily set ("HH:MM"). */
export function nextCustomDeparture(from: Date, departures: string[]): Date | null {
  const times = normalizeCustomDepartures(departures);
  if (times.length === 0) return null;

  const midnight = new Date(from);
  midnight.setHours(0, 0, 0, 0);
  for (const mins of times) {
    const candidate = new Date(midnight.getTime() + mins * 60_000);
    if (candidate.getTime() >= from.getTime()) return candidate;
  }
  // Roll over to the first departure tomorrow.
  return new Date(midnight.getTime() + 24 * 60 * 60_000 + times[0]! * 60_000);
}

export interface StationTimetable {
  scheduleKind?: "frequency" | "custom";
  firstDeparture: string;
  frequencyMinutes: number;
  customDepartures?: string[];
}

/** Next departure at-or-after `from` for either timetable kind. */
export function nextDepartureForStation(from: Date, station: StationTimetable): Date | null {
  if (station.scheduleKind === "custom") {
    return nextCustomDeparture(from, station.customDepartures ?? []);
  }
  return nextDeparture(from, station.firstDeparture, station.frequencyMinutes);
}

/** Whether a station's timetable is usable (frequency or non-empty custom set). */
export function isTimetableValid(station: StationTimetable): boolean {
  if (station.scheduleKind === "custom") {
    return normalizeCustomDepartures(station.customDepartures ?? []).length > 0;
  }
  const freq = Math.floor(Number(station.frequencyMinutes));
  return (
    Number.isFinite(freq) && freq > 0 && parseTimeToMinutes(station.firstDeparture) !== null
  );
}

export interface CatchPlan {
  /** departure you can still catch */
  departure: Date;
  /** time you must leave the location by */
  leaveBy: Date;
  /** the departure you just missed (if any) */
  missedDeparture: Date | null;
}

/**
 * Find the first departure whose `leaveBy = departure - walk` is still in the
 * future (or right now). If the immediate next transit is unreachable on foot,
 * roll forward to the following one.
 */
export function planCatch(
  now: Date,
  firstDeparture: string,
  frequencyMinutes: number,
  walkMinutes: number,
): CatchPlan | null {
  const freq = Math.floor(Number(frequencyMinutes));
  const walk = Math.max(0, Number(walkMinutes) || 0);
  if (!Number.isFinite(freq) || freq <= 0) return null;

  let departure = nextDeparture(now, firstDeparture, freq);
  if (!departure) return null;

  let missed: Date | null = null;
  // Guard against pathological walk times (e.g. 10h walk): cap iterations.
  for (let i = 0; i < 500; i++) {
    const leaveBy = new Date(departure.getTime() - walk * 60_000);
    if (leaveBy.getTime() > now.getTime()) {
      return { departure, leaveBy, missedDeparture: missed };
    }
    // Can't make this one — it becomes the "missed" one, try the next.
    missed = departure;
    departure = new Date(departure.getTime() + freq * 60_000);
  }
  return null;
}

/** Format a non-negative ms duration as H:MM:SS or MM:SS. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? m.toString().padStart(2, "0") : m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Format walk minutes nicely: 8 -> "8 min", 90 -> "1 h 30 min". */
export function formatWalk(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

export function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
