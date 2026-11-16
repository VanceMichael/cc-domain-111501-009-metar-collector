import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReport, parseDocument, splitReports } from '../src/metar.mjs';

const base = { document: 'doc', path: 'doc.txt', reportIndex: 0 };
const WINDOW = ['2026-10-31T23:00:00Z', '2026-11-01T01:00:00Z'];

test('wind keeps raw group, units, gust and variable-direction qualifiers', () => {
  const report = parseReport('SPECI ZAAA 010005Z 10008G15KT 0800 R09/0600U FG VV002 17/16 Q1014=', base);
  assert.equal(report.type, 'SPECI');
  assert.deepEqual(report.wind.direction, { raw: '100', value: 100, variable: false, missing: false });
  assert.equal(report.wind.speed.value, 8);
  assert.deepEqual(report.wind.gust, { raw: '15', value: 15, missing: false });
  assert.equal(report.wind.unit, 'KT');
  assert.equal(report.wind.source.token, '10008G15KT');
  assert.equal(report.wind.source.document, 'doc');
  assert.equal(report.wind.source.tokenIndex, 3);
});

test('calm wind 00000KT is a measured zero, not missing data', () => {
  const report = parseReport('METAR ZAAA 312350Z 00000KT CAVOK 18/10 Q1015=', base);
  assert.equal(report.wind.calm, true);
  assert.equal(report.wind.speed.value, 0);
  assert.equal(report.wind.speed.missing, false);
  assert.equal(report.wind.direction.value, 0);
});

test('sensor-not-reported wind stays missing and is never treated as zero', () => {
  const report = parseReport('METAR ZAAA 312350Z /////KT 0800 18/10 Q1015=', base);
  assert.equal(report.wind.speed.missing, true);
  assert.equal(report.wind.speed.value, null);
  assert.equal(report.wind.direction.missing, true);
  assert.equal(report.wind.calm, false);
});

test('CAVOK is a visibility kind and never fabricates cloud zero values', () => {
  const report = parseReport('METAR ZAAA 312350Z 09005KT CAVOK 18/10 Q1015=', base);
  assert.equal(report.visibility.kind, 'cavok');
  assert.equal(report.visibility.value, null);
  assert.equal(report.clouds.kind, 'cavok');
  assert.deepEqual(report.clouds.layers, []);
});

test('true zero visibility 0000 differs from missing //// and from CAVOK', () => {
  const zero = parseReport('METAR ZAAA 312350Z 09005KT 0000 18/10 Q1015=', base);
  assert.equal(zero.visibility.value, 0);
  assert.equal(zero.visibility.missing, false);
  assert.equal(zero.visibility.kind, 'meters');
  const missing = parseReport('METAR ZAAA 312350Z 09005KT //// 18/10 Q1015=', base);
  assert.equal(missing.visibility.missing, true);
  assert.equal(missing.visibility.value, null);
  const low = parseReport('METAR ZAAA 312350Z 09005KT M0000 18/10 Q1015=', base);
  assert.equal(low.visibility.belowMinimum, true);
  const far = parseReport('METAR ZAAA 312350Z 09005KT 9999 18/10 Q1015=', base);
  assert.equal(far.visibility.unbounded, true);
});

test('RVR retains runway, tendency, modifiers and is not merged into visibility', () => {
  const report = parseReport('SPECI ZAAA 010005Z 10008G15KT 0800 R09/0600U FG VV002 17/16 Q1014=', base);
  assert.equal(report.rvr.length, 1);
  const rvr = report.rvr[0];
  assert.equal(rvr.runway, '09');
  assert.equal(rvr.tendency, 'U');
  assert.equal(rvr.range.value, 600);
  assert.equal(rvr.unit, 'meters');
  assert.equal(rvr.source.token, 'R09/0600U');
  assert.equal(report.visibility.value, 800);
  const variable = parseReport('METAR ZAAA 312350Z 09005KT 2000 R27/P1200V1500D 18/10 Q1015=', base);
  assert.equal(variable.rvr.length, 1);
  assert.equal(variable.rvr[0].runway, '27');
  assert.equal(variable.rvr[0].range.modifier, 'P');
  assert.equal(variable.rvr[0].range.value, 1200);
  assert.equal(variable.rvr[0].variation.value, 1500);
  const rvrMissing = parseReport('METAR ZAAA 312350Z 09005KT 2000 R27//// 18/10 Q1015=', base);
  assert.equal(rvrMissing.rvr[0].range.missing, true);
});

test('cloud layers keep coverage, convective qualifier and height; VV is separate', () => {
  const report = parseReport('METAR ZAAA 312350Z 09005KT 5000 FEW020 BKN012CB 18/10 Q1015=', base);
  assert.equal(report.clouds.kind, 'layers');
  assert.deepEqual(report.clouds.layers.map(layer => layer.coverage), ['FEW', 'BKN']);
  assert.equal(report.clouds.layers[1].convection, 'CB');
  assert.equal(report.clouds.layers[0].altitude.feet, 2000);
  const vv = parseReport('SPECI ZAAA 010005Z 10008G15KT 0800 R09/0600U FG VV002 17/16 Q1014=', base);
  assert.equal(vv.clouds.kind, 'vertical-visibility');
  assert.equal(vv.clouds.verticalVisibility.feet, 200);
  const noCloud = parseReport('METAR ZAAA 312350Z 09005KT 9999 NSC 18/10 Q1015=', base);
  assert.equal(noCloud.clouds.keyword, 'NSC');
  assert.deepEqual(noCloud.clouds.layers, []);
});

test('NIL report has status nil and no synthesized observation groups', () => {
  const report = parseReport('METAR ZBBB 010010Z NIL=', base);
  assert.equal(report.status, 'nil');
  assert.equal(report.wind, null);
  assert.equal(report.visibility, null);
  assert.deepEqual(report.rvr, []);
  assert.equal(report.nilSource.token, 'NIL');
});

test('COR is captured as a correction flag while header identity stays METAR', () => {
  const report = parseReport('METAR COR ZAAA 312350Z 10006KT CAVOK 18/10 Q1015=', base);
  assert.equal(report.type, 'METAR');
  assert.equal(report.correction, true);
  assert.equal(report.wind.raw, '10006KT');
});

test('temperature and QNH missing markers stay missing, negatives parse signed', () => {
  const report = parseReport('METAR ZAAA 312350Z 09005KT 5000 M05/M10 Q////=', base);
  assert.equal(report.temperature.air.value, -5);
  assert.equal(report.temperature.dewpoint.value, -10);
  assert.equal(report.qnh.pressure.missing, true);
  assert.equal(report.qnh.pressure.value, null);
});

test('unknown groups are isolated with position and make interpretation partial', () => {
  const report = parseReport('METAR ZAAA 312350Z 09005KT 5000 ZZZ99 18/10 Q1015=', base);
  assert.equal(report.interpretation, 'partial');
  assert.equal(report.unknown[0].raw, 'ZZZ99');
  assert.equal(report.unknown[0].reason, 'unrecognised-group');
  assert.equal(report.unknown[0].tokenIndex, 5);
  assert.equal(report.visibility.value, 5000);
});

test('a document can hold multiple reports and malformed ones are reported not dropped', () => {
  const parsed = parseDocument({ id: 'd', path: 'd.txt',
    text: 'METAR ZAAA 312350Z 09005KT CAVOK 18/10 Q1015=\nGARBAGE WITHOUT HEADER=\n' });
  assert.equal(parsed.reports.length, 1);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].code, 'unrecognised-report');
  assert.equal(parsed.errors[0].reportIndex, 1);
  assert.equal(splitReports('A=\nB=')[0].raw, 'A');
});

test('transmission window is not needed by the parser; groups are positionally sourced', () => {
  const report = parseReport('METAR ZAAA 312350Z 09005KT 5000 18/10 Q1015=');
  assert.equal(report.timeGroup.source.path, undefined);
  assert.equal(report.timeGroup.raw, '312350Z');
  assert.equal(WINDOW.length, 2);
});
