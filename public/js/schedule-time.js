// public/js/schedule-time.js
//
// Pure time arithmetic for the schedule, kept apart from the page so it can be
// tested directly -- the week-wrapping in findNowAndNext is the part most
// likely to be quietly wrong, and it is not something you can see by looking
// at the page.
//
// Everything is compared in local time against day-of-week (0-6, Sunday
// first, matching Date#getDay) and "HH:MM" strings. A campus timetable is only
// ever read on campus, so there is no timezone to convert.

export const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MINUTES_PER_DAY = 1440;

/** "09:30" -> 570 */
export function minutesOf(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

/** "13:05" -> "1:05pm" */
export function formatTime(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const suffix = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")}${suffix}`;
}

/**
 * "SW3-1600" / "sw3 1600" -> { building, room }; null if no building code.
 * Same shape the map and its deep links accept, so what you type in the
 * schedule is what you can paste anywhere else in the app.
 */
export function parseRoomRef(raw) {
  const s = (raw || "").trim().toUpperCase();
  const m = s.match(/^([A-Z]+\d*)[-\s]+(\S.*)$/);
  return m ? { building: m[1], room: m[2].trim() } : null;
}

/**
 * The class happening right now, and the next one due.
 *
 * `next` looks forward across the whole week and wraps: on Friday afternoon
 * the next class is Monday morning, not "none". Without the wrap the page
 * would go blank every weekend, which is exactly when someone checks what
 * they have on Monday.
 *
 * @param {Array} schedule entries of { days:[0-6], startTime, endTime, ... }
 * @param {Date} at
 * @returns {{current: ?{entry, day}, next: ?{entry, day, inMinutes}}}
 */
export function findNowAndNext(schedule, at = new Date()) {
  const today = at.getDay();
  const nowMin = at.getHours() * 60 + at.getMinutes();

  let current = null;
  let next = null;
  let bestDelta = Infinity;

  for (const entry of schedule || []) {
    for (const day of entry.days || []) {
      const start = minutesOf(entry.startTime);
      const end = minutesOf(entry.endTime);

      if (day === today && nowMin >= start && nowMin < end) {
        current = { entry, day };
      }

      let delta = (day - today) * MINUTES_PER_DAY + (start - nowMin);
      if (delta < 0) delta += 7 * MINUTES_PER_DAY;
      if (delta > 0 && delta < bestDelta) {
        bestDelta = delta;
        next = { entry, day, inMinutes: delta };
      }
    }
  }
  return { current, next };
}

/**
 * What the map's banner needs: a class on now, or one starting within
 * `soonMinutes`. Today only -- the map is answering "where do I have to be",
 * not "what does my week look like".
 */
export function classDueNow(schedule, at = new Date(), soonMinutes = 30) {
  const today = at.getDay();
  const nowMin = at.getHours() * 60 + at.getMinutes();
  let soonest = null;

  for (const entry of schedule || []) {
    for (const day of entry.days || []) {
      if (day !== today) continue;
      const start = minutesOf(entry.startTime);
      const end = minutesOf(entry.endTime);
      if (nowMin >= start && nowMin < end) return { entry, status: "now" };
      const until = start - nowMin;
      if (until > 0 && until <= soonMinutes && (!soonest || until < soonest.until)) {
        soonest = { entry, status: "soon", until };
      }
    }
  }
  return soonest;
}
