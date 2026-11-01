'use strict';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parse "HH:MM" into minutes since midnight. Returns null when invalid. */
function parseTime(value) {
  if (typeof value !== 'string') return null;
  const match = TIME_RE.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isValidTime(value) {
  return parseTime(value) !== null;
}

function formatTime(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * True when the venue opening window fully contains the requested slot after
 * extending the slot by `bufferMinutes` on both sides (travel buffer).
 * A venue with no hours metadata is treated as "always open".
 */
function isWithinHours(hours, startTime, endTime, bufferMinutes = 0) {
  const slotStart = parseTime(startTime);
  const slotEnd = parseTime(endTime);
  if (slotStart === null || slotEnd === null || slotEnd <= slotStart) return false;

  if (!hours || (!hours.open && !hours.close)) return true;
  const open = parseTime(hours.open);
  const close = parseTime(hours.close);
  if (open === null || close === null) return false;

  return slotStart - bufferMinutes >= open && slotEnd + bufferMinutes <= close;
}

/** Overlap check on half-open intervals [start, end). */
function overlaps(a, b) {
  const aStart = parseTime(a.startTime);
  const aEnd = parseTime(a.endTime);
  const bStart = parseTime(b.startTime);
  const bEnd = parseTime(b.endTime);
  if ([aStart, aEnd, bStart, bEnd].some((v) => v === null)) return false;
  return aStart < bEnd && bStart < aEnd;
}

function toDateOnly(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Inclusive day count between two ISO dates (YYYY-MM-DD). */
function tripDayCount(startDate, endDate) {
  const start = toDateOnly(startDate).getTime();
  const end = toDateOnly(endDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 86400000) + 1;
}

module.exports = { parseTime, isValidTime, formatTime, isWithinHours, overlaps, tripDayCount, toDateOnly };
