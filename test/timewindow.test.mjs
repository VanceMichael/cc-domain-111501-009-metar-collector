import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveObservationTime } from '../src/timewindow.mjs';

const group = (day, hour, minute) => ({ raw: `${day}${hour}${minute}Z`, day, hour, minute });
const WINDOW = ['2026-10-31T23:00:00Z', '2026-11-01T01:00:00Z'];

test('late bulletin on the 31st resolves into the previous month without using host clock', () => {
  const result = resolveObservationTime(group(31, 23, 50), WINDOW);
  assert.equal(result.status, 'resolved');
  assert.equal(result.observedAt, '2026-10-31T23:50:00Z');
});

test('first-of-month report resolves into the new month', () => {
  const result = resolveObservationTime(group(1, 0, 5), WINDOW);
  assert.equal(result.observedAt, '2026-11-01T00:05:00Z');
});

test('a day-time outside the transmission window has no candidate and stays pending', () => {
  const result = resolveObservationTime(group(15, 12, 0), WINDOW);
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'no-candidate-in-window');
  assert.deepEqual(result.candidates, []);
});

test('a window wide enough to repeat a day-time yields multiple candidates and stays pending', () => {
  // Two months long: day 1 at 00:30 occurs in both November and December.
  const wide = ['2026-11-01T00:00:00Z', '2026-12-01T01:00:00Z'];
  const result = resolveObservationTime(group(1, 0, 30), wide);
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'observation-time-not-unique');
  assert.deepEqual(result.candidates, ['2026-11-01T00:30:00Z', '2026-12-01T00:30:00Z']);
});

test('impossible calendar days cannot match by month roll-over', () => {
  const result = resolveObservationTime(group(31, 23, 30), ['2026-11-01T00:00:00Z', '2026-11-30T23:59:00Z']);
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'no-candidate-in-window');
});

test('missing or invalid windows never fall back to the local month', () => {
  const missing = resolveObservationTime(group(31, 23, 50), null);
  assert.equal(missing.status, 'pending');
  assert.equal(missing.reason, 'transmission-window-unavailable');
  const invalid = resolveObservationTime(group(31, 23, 50), ['not-a-date', 'also-bad']);
  assert.equal(invalid.status, 'pending');
  assert.equal(invalid.reason, 'transmission-window-invalid');
});

test('boundary instants at window edges are accepted', () => {
  const atStart = resolveObservationTime(group(31, 23, 0), WINDOW);
  assert.equal(atStart.observedAt, '2026-10-31T23:00:00Z');
  const atEnd = resolveObservationTime(group(1, 1, 0), WINDOW);
  assert.equal(atEnd.observedAt, '2026-11-01T01:00:00Z');
});
