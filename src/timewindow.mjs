// Resolve a report's day-hour-minute group into a full UTC instant.
//
// A METAR only carries DDHHMM, so the month/year must come from the
// transmission window advertised by the authorized gateway — never from the
// collector host's clock (a late bulletin can arrive across a month
// boundary). Each month intersecting the window is a candidate; a candidate
// counts only if its constructed instant lies inside the window. When zero or
// several candidates remain, the time is unresolved and the report waits for
// manual verification instead of being guessed.

function isoUtc(year, month, day, hour, minute) {
  const pad = value => String(value).padStart(2, '0');
  return `${year}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00Z`;
}

function monthsBetween(start, end) {
  const months = [];
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  while (year < end.getUTCFullYear()
    || (year === end.getUTCFullYear() && month <= end.getUTCMonth())) {
    months.push({ year, month });
    month += 1;
    if (month === 12) { month = 0; year += 1; }
    if (months.length > 24) break; // defensive stop; a sane window is hours wide
  }
  return months;
}

export function resolveObservationTime(timeGroup, transmissionWindow) {
  if (!Array.isArray(transmissionWindow) || transmissionWindow.length !== 2) {
    return { status: 'pending', reason: 'transmission-window-unavailable',
      day: timeGroup.day, hour: timeGroup.hour, minute: timeGroup.minute, candidates: [] };
  }
  const [startText, endText] = transmissionWindow;
  const windowStart = Date.parse(startText);
  const windowEnd = Date.parse(endText);
  if (Number.isNaN(windowStart) || Number.isNaN(windowEnd) || windowStart > windowEnd) {
    return { status: 'pending', reason: 'transmission-window-invalid',
      day: timeGroup.day, hour: timeGroup.hour, minute: timeGroup.minute, candidates: [] };
  }
  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  const candidates = [];
  for (const { year, month } of monthsBetween(start, end)) {
    // Date.UTC with an out-of-range day rolls over to the next month; reject
    // those so impossible calendar days (e.g. 31 February) never match.
    const instant = Date.UTC(year, month, timeGroup.day, timeGroup.hour, timeGroup.minute);
    const probe = new Date(instant);
    if (probe.getUTCMonth() !== month || probe.getUTCFullYear() !== year) continue;
    if (instant < windowStart || instant > windowEnd) continue;
    candidates.push(isoUtc(year, month, timeGroup.day, timeGroup.hour, timeGroup.minute));
  }
  if (candidates.length === 1) {
    return { status: 'resolved', observedAt: candidates[0], candidates };
  }
  return {
    status: 'pending',
    reason: candidates.length === 0 ? 'no-candidate-in-window' : 'observation-time-not-unique',
    day: timeGroup.day, hour: timeGroup.hour, minute: timeGroup.minute, candidates
  };
}
