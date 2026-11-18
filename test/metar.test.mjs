import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReport, resolveObservationTime, splitReports } from '../src/metar.mjs';

const source = { documentId: 'doc', path: 'sample.txt', digest: 'd0', reportIndex: 0 };
const WINDOW = ['2026-10-31T23:00:00Z', '2026-11-01T01:00:00Z'];

test('CAVOK is a distinct condition and never fabricates cloud or visibility zeros', () => {
  const report = parseReport('METAR ZAAA 312350Z 09005KT CAVOK 18/10 Q1015', source);
  assert.equal(report.cavok, true);
  assert.equal(report.visibility.kind, 'cavok');
  assert.equal(report.visibility.meters, null);
  assert.deepEqual(report.clouds, []);
  assert.equal(report.interpreted, true);
});

test('true zero wind, visibility and ceiling keep numeric zero instead of being treated as missing', () => {
  const report = parseReport('METAR ZAAA 312350Z 00000KT 0000 VV000 18/10 Q1015', source);
  assert.equal(report.wind.calm, true);
  assert.equal(report.wind.directionDeg, 0);
  assert.equal(report.wind.speedKt, 0);
  assert.equal(report.wind.notReported, false);
  assert.equal(report.visibility.kind, 'meters');
  assert.equal(report.visibility.meters, 0);
  assert.equal(report.clouds[0].kind, 'VV');
  assert.equal(report.clouds[0].heightHundredFt, 0);
  assert.equal(report.clouds[0].notReported, false);
});

test('slash groups mean sensor/source not reported and never produce numeric values', () => {
  const report = parseReport(
    'METAR ZAAA 312350Z ///KT //// VV/// R09///// 18// Q////', source);
  assert.equal(report.wind.notReported, true);
  assert.equal(report.wind.directionDeg, null);
  assert.equal(report.wind.speedKt, null);
  assert.equal(report.visibility.kind, 'not-reported');
  assert.equal(report.visibility.meters, null);
  assert.equal(report.clouds[0].notReported, true);
  assert.equal(report.clouds[0].heightHundredFt, null);
  assert.equal(report.rvr[0].notReported, true);
  assert.equal(report.rvr[0].min, null);
  assert.equal(report.temperature.tempC, 18);
  assert.equal(report.temperature.dewpointC, null);
  assert.equal(report.qnh.hpa, null);
  assert.equal(report.qnh.notReported, true);
});

test('a missing field stays null while a present not-reported field stays an object', () => {
  const report = parseReport('METAR ZAAA 312350Z 09005KT 8000 18/10 Q1015', source);
  assert.equal(report.wind.notReported, false);
  assert.deepEqual(report.rvr, []);
  assert.deepEqual(report.clouds, []);
  assert.equal(report.qnh.hpa, 1015);
});

test('SPECI RVR keeps runway identifier and U trend, distinct from surface visibility', () => {
  const report = parseReport(
    'SPECI ZAAA 010005Z 10008G15KT 0800 R09/0600U FG VV002 17/16 Q1014', source);
  assert.equal(report.kind, 'SPECI');
  assert.equal(report.visibility.meters, 800);
  assert.equal(report.rvr.length, 1);
  assert.deepEqual(report.rvr[0].runway, '09');
  assert.equal(report.rvr[0].trend, 'U');
  assert.equal(report.rvr[0].min, 600);
  assert.equal(report.weather[0].code, 'FG');
});

test('NIL report is explicitly nil and carries no weather fields', () => {
  const report = parseReport('METAR ZBBB 010010Z NIL', source);
  assert.equal(report.status, 'nil');
  assert.equal(report.wind, null);
  assert.equal(report.visibility, null);
  assert.equal(report.interpreted, true);
});

test('COR correction flag is captured while the raw group is preserved', () => {
  const report = parseReport('METAR COR ZAAA 312350Z 10006KT CAVOK 18/10 Q1015', source);
  assert.equal(report.correction, 'COR');
  assert.equal(report.wind.raw, '10006KT');
  assert.equal(report.wind.source.token, 4);
});

test('unknown groups are isolated and the record is not called fully interpreted', () => {
  const report = parseReport('METAR ZAAA 312350Z 09005KT 8000 ZZ999 18/10 Q1015', source);
  assert.equal(report.interpreted, false);
  assert.equal(report.unknownGroups[0].raw, 'ZZ999');
  assert.equal(report.unknownGroups[0].source.documentId, 'doc');
});

test('reports split on newlines or the equals terminator', () => {
  assert.deepEqual(splitReports('METAR A 312350Z Q1015=\nSPECI B 010005Z Q1014='),
    ['METAR A 312350Z Q1015', 'SPECI B 010005Z Q1014']);
});

test('a bulletin document can carry several reports, each keeping its own source index', () => {
  const lines = splitReports('METAR ZAAA 312350Z 09005KT Q1015=\nSPECI ZAAA 010005Z 10008KT Q1014=');
  const first = parseReport(lines[0], { documentId: 'bulk', digest: 'd1', reportIndex: 0 });
  const second = parseReport(lines[1], { documentId: 'bulk', digest: 'd1', reportIndex: 1 });
  assert.equal(first.kind, 'METAR');
  assert.equal(second.kind, 'SPECI');
  assert.equal(second.source.reportIndex, 1);
});

test('a calm group and a not-reported wind group are never conflated', () => {
  const calm = parseReport('METAR ZAAA 312350Z 00000KT 9999 18/10 Q1015', source);
  const missing = parseReport('METAR ZAAA 312350Z /////KT 9999 18/10 Q1015', source);
  assert.equal(calm.wind.calm, true);
  assert.equal(calm.wind.notReported, false);
  assert.equal(missing.wind.calm, false);
  assert.equal(missing.wind.notReported, true);
  assert.equal(missing.wind.speedKt, null);
});

test('malformed headers and missing mandatory groups are rejected with positions', () => {
  assert.throws(() => parseReport('TAF ZAAA 312350Z', source), /unsupported/);
  assert.throws(() => parseReport('METAR 312350Z', source), /station/);
  assert.throws(() => parseReport('METAR ZAAA Q1015', source), /day\/time/);
});

test('cross-month day/time resolves the month candidate from the window, not the local clock', () => {
  const endOfMonth = resolveObservationTime('312350Z', WINDOW);
  assert.equal(endOfMonth.status, 'resolved');
  assert.deepEqual(endOfMonth.candidates, ['2026-10-31T23:50:00Z']);
  const nextMonth = resolveObservationTime('010010Z', WINDOW);
  assert.equal(nextMonth.status, 'resolved');
  assert.deepEqual(nextMonth.candidates, ['2026-11-01T00:10:00Z']);
});

test('a window matching two months for one day/time stays ambiguous and pending review', () => {
  const wideWindow = ['2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z'];
  const result = resolveObservationTime('302350Z', wideWindow);
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.candidates, ['2026-10-30T23:50:00Z', '2026-11-30T23:50:00Z']);
});

test('day/time outside the transmission window cannot be placed', () => {
  assert.equal(resolveObservationTime('020000Z', WINDOW).status, 'outside-window');
  assert.equal(resolveObservationTime('312200Z', WINDOW).status, 'outside-window');
});

test('impossible calendar days are rejected instead of rolling into the next month', () => {
  // 31 日在 11 月不存在，不能滚成 12 月 1 日。
  const result = resolveObservationTime('312350Z',
    ['2026-11-01T00:00:00Z', '2026-11-30T23:59:00Z']);
  assert.equal(result.status, 'outside-window');
});
