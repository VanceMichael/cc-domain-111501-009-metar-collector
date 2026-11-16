// Structured METAR/SPECI parsing for the profile defined in docs/protocol.md.
//
// Design rules demanded by the domain:
//   * every interpreted group keeps its original token and its source position;
//   * CAVOK is a visibility kind, never a fabricated zero cloud/visibility value;
//   * sensor-not-reported markers (//, ///, ////) stay "missing", distinct from
//     real measured zeros (0000, 00000KT);
//   * groups outside the profile are isolated in `unknown`, never silently
//     dropped, and make the report interpretation "partial";
//   * the parser only describes the report. It does not forecast, substitute
//     defaults, or judge airworthiness.

const HEADER = /^(METAR|SPECI)$/;
const TIME_GROUP = /^(\d{2})(\d{2})(\d{2})Z$/;
const STATION = /^[A-Z]{4}$/;
const WIND = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)(?:V?(\d{3})V(\d{3}))?$/;
const WIND_MISSING = /^\/\/\/\/\/(KT|MPS)$/;
const VARIABLE_WIND = /^(\d{3})V(\d{3})$/;
const VISIBILITY = /^(M)?(\d{4}|\/\/\/\/)(NDV)?$/;
// After the mandatory "/" separator, a missing RVR range is three slashes.
const RVR = /^R(\d{2}[LCR]?)\/(?:([MP])?(\d{4}|\/\/\/)|\/\/\/)(?:V(?:([MP])?(\d{4}|\/\/\/)))?([UDN])?(FT)?$/;
const CLOUD = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU)?$/;
const CLOUD_KEYWORD = /^(NSC|NCD|SKC|CAVOK)$/;
// The "/" between air and dewpoint is structural; a missing value is "//".
// Alternatives are ordered explicitly so the separator cannot be swallowed.
const TEMPERATURE = /^(?:(M?\d{2})|(\/\/))\/(?:(M?\d{2})|(\/\/))$/;
const QNH = /^Q(\d{4}|\/\/\/\/)$/;
const WEATHER = /^([+-]|VC)?(?:MI|PR|BC|DR|BL|SH|TS|FZ|DZ|RA|SN|SG|IC|PL|GR|GS|FG|BR|SA|DU|HZ|FU|VA|PO|SQ|FC|SS|DS){1,3}$/;

function location(base, token, tokenIndex) {
  return { ...base, token, tokenIndex };
}

function signedValue(token) {
  if (token === '//') return { value: null, missing: true };
  const negative = token.startsWith('M');
  return { value: Number(negative ? token.slice(1) : token) * (negative ? -1 : 1), missing: false };
}

function parseWind(token, base, tokenIndex) {
  const source = location(base, token, tokenIndex);
  const missing = WIND_MISSING.exec(token);
  if (missing) {
    return { raw: token, unit: missing[1], calm: false,
      direction: { raw: null, value: null, variable: false, missing: true },
      speed: { raw: null, value: null, missing: true }, gust: null, variation: null, source };
  }
  const match = WIND.exec(token);
  if (!match) return null;
  const [, directionToken, speedToken, gustToken, unit, fromToken, toToken] = match;
  const speed = Number(speedToken);
  const wind = {
    raw: token,
    unit,
    calm: directionToken === '000' && speed === 0,
    direction: { raw: directionToken, value: directionToken === 'VRB' ? null : Number(directionToken),
      variable: directionToken === 'VRB', missing: false },
    speed: { raw: speedToken, value: speed, missing: false },
    gust: gustToken ? { raw: gustToken, value: Number(gustToken), missing: false } : null,
    variation: fromToken ? { raw: `${fromToken}V${toToken}`, from: Number(fromToken), to: Number(toToken) } : null,
    source
  };
  return wind;
}

function parseVisibility(token, base, tokenIndex) {
  const source = location(base, token, tokenIndex);
  if (token === 'CAVOK') return { kind: 'cavok', raw: token, value: null, missing: false, source };
  const match = VISIBILITY.exec(token);
  if (!match) return null;
  const [, modifier, digits, ndv] = match;
  if (digits === '////') {
    return { kind: 'meters', raw: token, value: null, missing: true, source };
  }
  const value = Number(digits);
  return {
    kind: 'meters', raw: token, value, missing: false,
    modifier: modifier ?? null,
    // 9999 means "10 km or more", M0000 means "less than 50 m": qualifiers,
    // not fabricated substitutes for the measured group.
    unbounded: digits === '9999',
    belowMinimum: modifier === 'M',
    noDirectionalVariation: Boolean(ndv),
    source
  };
}

function parseRvr(token, base, tokenIndex) {
  const match = RVR.exec(token);
  if (!match) return null;
  const source = location(base, token, tokenIndex);
  const [, runway, modifierToken, rangeToken, variationModifier, variationToken, tendency, feet] = match;
  const isMissing = value => typeof value === 'string' && value.startsWith('///');
  const range = isMissing(rangeToken)
    ? { raw: rangeToken, value: null, modifier: null, missing: true }
    : { raw: rangeToken, value: Number(rangeToken), modifier: modifierToken ?? null, missing: false };
  const variation = variationToken
    ? (isMissing(variationToken)
        ? { raw: variationToken, value: null, modifier: variationModifier ?? null, missing: true }
        : { raw: variationToken, value: Number(variationToken), modifier: variationModifier ?? null, missing: false })
    : null;
  return {
    raw: token, runway,
    // RVR is its own observation: keep runway unit and tendency attached,
    // never fold it into ordinary surface visibility.
    unit: feet ? 'feet' : 'meters',
    tendency: tendency ?? null,
    range, variation, source
  };
}

function parseCloud(token, base, tokenIndex) {
  const source = location(base, token, tokenIndex);
  if (CLOUD_KEYWORD.exec(token)) return { kind: 'keyword', keyword: token, layers: [], source };
  const match = CLOUD.exec(token);
  if (!match) return null;
  const [, coverage, altitudeToken, convection] = match;
  const layer = {
    raw: token, coverage,
    convection: convection ?? null,
    altitude: altitudeToken === '///'
      ? { raw: altitudeToken, feet: null, missing: true }
      : { raw: altitudeToken, feet: Number(altitudeToken) * 100, missing: false },
    source
  };
  if (coverage === 'VV') {
    return { kind: 'vertical-visibility', layers: [layer],
      verticalVisibility: layer.altitude, source };
  }
  return { kind: 'layers', layers: [layer], source };
}

function mergeClouds(previous, next) {
  if (!previous) return next;
  if (previous.kind !== 'layers' || next.kind !== 'layers') {
    return { kind: 'mixed', keyword: previous.keyword ?? next.keyword ?? null,
      layers: [...previous.layers, ...next.layers],
      verticalVisibility: previous.verticalVisibility ?? next.verticalVisibility ?? null,
      sources: [previous.source, next.source] };
  }
  return { kind: 'layers', layers: [...previous.layers, ...next.layers],
    sources: [previous.source, next.source] };
}

function parseTemperature(token, base, tokenIndex) {
  const match = TEMPERATURE.exec(token);
  if (!match) return null;
  const [, airValue, airMissingToken, dewValue, dewMissingToken] = match;
  const airToken = airValue ?? airMissingToken;
  const dewToken = dewValue ?? dewMissingToken;
  const air = signedValue(airToken);
  const dew = signedValue(dewToken);
  return {
    raw: token,
    air: { raw: airToken, ...air },
    dewpoint: { raw: dewToken, ...dew },
    source: location(base, token, tokenIndex)
  };
}

function parseQnh(token, base, tokenIndex) {
  const match = QNH.exec(token);
  if (!match) return null;
  const digits = match[1];
  return {
    raw: token, unit: 'hPa',
    pressure: digits === '////' ? { raw: digits, value: null, missing: true }
      : { raw: digits, value: Number(digits), missing: false },
    source: location(base, token, tokenIndex)
  };
}

// Split one document into individual reports. METAR bulletins terminate a
// report with "="; a document may carry several reports or blank lines.
export function splitReports(text) {
  return text.split(/\r?\n/)
    .flatMap(line => line.split('='))
    .map(chunk => chunk.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((raw, reportIndex) => ({ raw, reportIndex }));
}

export function parseReport(raw, base = {}) {
  // The "=" bulletin terminator may remain when a single report is parsed
  // directly; strip it before tokenizing so the last group stays clean.
  const tokens = raw.replace(/=\s*$/, '').split(' ').filter(Boolean);
  const unknown = [];
  const header = HEADER.exec(tokens[0]);
  if (!header) {
    const error = new Error(`unsupported report header: ${tokens[0] ?? 'empty'}`);
    error.code = 'unrecognised-report';
    error.location = base;
    throw error;
  }
  const report = {
    raw,
    type: header[1],
    correction: false,
    station: null,
    timeGroup: null,
    status: 'normal',
    wind: null,
    visibility: null,
    weather: [],
    clouds: null,
    rvr: [],
    temperature: null,
    qnh: null,
    unknown,
    interpretation: 'complete'
  };

  let cursor = 1;
  if (tokens[cursor] === 'COR') {
    report.correction = true;
    cursor += 1;
  }
  if (STATION.exec(tokens[cursor] ?? '')) {
    report.station = tokens[cursor];
    cursor += 1;
  } else {
    const error = new Error('station identifier missing or malformed');
    error.code = 'malformed-report';
    error.location = location(base, tokens[cursor] ?? null, cursor);
    throw error;
  }
  const timeMatch = TIME_GROUP.exec(tokens[cursor] ?? '');
  if (!timeMatch) {
    const error = new Error('observation day/time group missing or malformed');
    error.code = 'malformed-report';
    error.location = location(base, tokens[cursor] ?? null, cursor);
    throw error;
  }
  report.timeGroup = {
    raw: tokens[cursor],
    day: Number(timeMatch[1]), hour: Number(timeMatch[2]), minute: Number(timeMatch[3]),
    source: location(base, tokens[cursor], cursor)
  };
  cursor += 1;

  if (tokens[cursor] === 'NIL') {
    report.status = 'nil';
    report.nilSource = location(base, 'NIL', cursor);
    cursor += 1;
    if (cursor < tokens.length) {
      unknown.push(...tokens.slice(cursor).map((token, offset) =>
        ({ raw: token, reason: 'group-after-nil', ...location(base, token, cursor + offset) })));
      report.interpretation = 'partial';
    }
    return report;
  }

  for (let index = cursor; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === 'CAVOK') {
      report.visibility = parseVisibility(token, base, index);
      // CAVOK also governs cloud/weather, but it supplies no numeric cloud
      // height: record the governance rather than inventing a zero layer.
      report.clouds = mergeClouds(report.clouds,
        { kind: 'cavok', layers: [], source: location(base, token, index) });
      continue;
    }
    const wind = parseWind(token, base, index);
    if (wind) { report.wind = wind; continue; }
    const variable = VARIABLE_WIND.exec(token);
    if (variable && report.wind) {
      report.wind.variation = { raw: token, from: Number(variable[1]), to: Number(variable[2]) };
      continue;
    }
    const visibility = parseVisibility(token, base, index);
    if (visibility) { report.visibility = visibility; continue; }
    const rvr = parseRvr(token, base, index);
    if (rvr) { report.rvr.push(rvr); continue; }
    const cloud = parseCloud(token, base, index);
    if (cloud) { report.clouds = mergeClouds(report.clouds, cloud); continue; }
    const temperature = parseTemperature(token, base, index);
    if (temperature) { report.temperature = temperature; continue; }
    const qnh = parseQnh(token, base, index);
    if (qnh) { report.qnh = qnh; continue; }
    if (WEATHER.exec(token)) {
      report.weather.push({ raw: token, source: location(base, token, index) });
      continue;
    }
    unknown.push({ raw: token, reason: 'unrecognised-group', ...location(base, token, index) });
    report.interpretation = 'partial';
  }
  return report;
}

// Parse a retained document. A malformed individual report is recorded as an
// error with its position instead of discarding the whole document.
export function parseDocument({ id, path, text }) {
  const entries = splitReports(text);
  const reports = [];
  const errors = [];
  for (const { raw, reportIndex } of entries) {
    const base = { document: id, path, reportIndex };
    try {
      reports.push(parseReport(raw, base));
    } catch (error) {
      errors.push({ document: id, path, reportIndex, raw,
        code: error.code ?? 'parse-error', reason: error.message, location: error.location ?? base });
    }
  }
  return { document: id, path, reports, errors };
}
