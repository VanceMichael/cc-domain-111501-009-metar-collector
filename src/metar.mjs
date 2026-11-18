// METAR/SPECI 结构化解析（纯函数，不接触时钟与网络）。
// 关键语义边界：
//  - CAVOK 是显式天气状况标记：visibility.kind='cavok'，不虚构任何云层/能见度数值；
//  - 斜杠组（////KT、////、VV///、R../////、Q////）表示传感器/来源未报，kind='not-reported'，不产生数值；
//  - 真零值（00000KT、0000、VV000、R../0000）是有效观测数值，照常解析为 0；
//  - 字段缺失（整组不存在）与“未报”不同：缺失为 null，未报为带 notReported 的对象。
// 本 profile 只覆盖协议约定的组，未识别组进入 unknownGroups 隔离，不得算作已解释。

const WIND_UNIT = 'KT';

const CLOUD_CODES = ['FEW', 'SCT', 'BKN', 'OVC'];
const WEATHER_PHENOMENA = 'DZ|RA|SN|SG|IC|PL|GR|GS|FG|BR|SA|DU|HZ|FU|VA|PO|SQ|FC|SS|DS|UP|TS|SH|FZ';
const WEATHER_RE = new RegExp(`^([+-]|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?(?:${WEATHER_PHENOMENA})+$`);

export function splitReports(text) {
  return text
    .replace(/=/g, '\n')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function field(raw, source, extra = {}) {
  return { raw, source: { ...source }, ...extra };
}

function parseWind(token, source) {
  if (token === '00000KT') {
    return field(token, source, { kind: 'wind', calm: true, variable: false,
      directionDeg: 0, speedKt: 0, gustKt: null, notReported: false });
  }
  let match = /^VRB(\d{2,3})(?:G(\d{2,3}))?KT$/.exec(token);
  if (match) {
    return field(token, source, { kind: 'wind', calm: false, variable: true,
      directionDeg: null, speedKt: Number(match[1]),
      gustKt: match[2] === undefined ? null : Number(match[2]), notReported: false });
  }
  match = /^(\d{3}|\/\/\/)(\d{2,3}|\/\/)(?:G(\d{2,3}|\/\/))?KT$/.exec(token);
  if (match) {
    const directionNotReported = match[1] === '///';
    const speedNotReported = match[2] === '//';
    const gustRaw = match[3];
    const notReported = directionNotReported || speedNotReported || gustRaw === '//';
    return field(token, source, { kind: 'wind', unit: WIND_UNIT, calm: false, variable: false,
      directionDeg: directionNotReported ? null : Number(match[1]),
      speedKt: speedNotReported ? null : Number(match[2]),
      gustKt: gustRaw === undefined ? null : (gustRaw === '//' ? null : Number(gustRaw)),
      notReported });
  }
  // 整体斜杠的风组（如 ////KT）同样是未报，而不是静风。
  if (/^\/{3,5}(?:G\/{2,4})?KT$/.test(token)) {
    return field(token, source, { kind: 'wind', unit: WIND_UNIT, calm: false, variable: false,
      directionDeg: null, speedKt: null, gustKt: null, notReported: true });
  }
  return null;
}

function parseVisibility(token, source) {
  if (token === 'CAVOK') {
    return field(token, source, { kind: 'cavok', meters: null, notReported: false });
  }
  if (token === '////') {
    return field(token, source, { kind: 'not-reported', meters: null, notReported: true });
  }
  const match = /^(\d{4})$/.exec(token);
  if (match) {
    return field(token, source, { kind: 'meters', meters: Number(match[1]), notReported: false });
  }
  return null;
}

function parseRvr(token, source) {
  const match = /^R(\d{2}[LCR]?)\/(M|P)?(\d{4}|\/{4})(?:V(\d{4}))?(U|D|N)?$/.exec(token);
  if (!match) return null;
  const [, runway, modifier, valueRaw, maxRaw, trend] = match;
  const notReported = valueRaw === '////';
  return field(token, source, {
    kind: 'rvr',
    runway,
    modifier: modifier ?? null,
    min: notReported ? null : Number(valueRaw),
    max: maxRaw === undefined ? null : Number(maxRaw),
    trend: trend ?? null,
    notReported
  });
}

function parseCloud(token, source) {
  if (token === 'NSC' || token === 'NCD') {
    return field(token, source, { kind: token, heightHundredFt: null, convection: null, notReported: false });
  }
  let match = /^VV(\d{3}|\/\/\/)$/.exec(token);
  if (match) {
    const notReported = match[1] === '///';
    return field(token, source, { kind: 'VV',
      heightHundredFt: notReported ? null : Number(match[1]),
      convection: null, notReported });
  }
  match = new RegExp(`^(${CLOUD_CODES.join('|')})(\\d{3}|\\/\\/\\/)(CB|TCU)?$`).exec(token);
  if (match) {
    const notReported = match[2] === '///';
    return field(token, source, { kind: match[1],
      heightHundredFt: notReported ? null : Number(match[2]),
      convection: match[3] ?? null, notReported });
  }
  return null;
}

function parseTemperature(token, source) {
  const match = /^(M?\d{2}|\/{1,2})\/(M?\d{2}|\/{1,2})$/.exec(token);
  if (!match) return null;
  const value = part => (/^\/+$/.test(part) ? null : (part.startsWith('M') ? -Number(part.slice(1)) : Number(part)));
  return field(token, source, { kind: 'temperature',
    tempC: value(match[1]), dewpointC: value(match[2]),
    notReported: /^\/+$/.test(match[1]) || /^\/+$/.test(match[2]) });
}

function parseQnh(token, source) {
  const match = /^Q(\d{4}|\/{4})$/.exec(token);
  if (!match) return null;
  return field(token, source, { kind: 'qnh',
    hpa: /^\/+$/.test(match[1]) ? null : Number(match[1]),
    notReported: /^\/+$/.test(match[1]) });
}

// 解析单份电报。source 携带文档级来源坐标，字段级来源再附加 token 序号。
export function parseReport(raw, source) {
  const tokens = raw.trim().split(/\s+/);
  const head = tokens[0];
  if (head !== 'METAR' && head !== 'SPECI') {
    throw new Error(`unsupported report kind: ${head ?? '(empty)'}`);
  }
  const report = {
    kind: head,
    correction: null,
    station: null,
    timeGroup: null,
    status: 'normal',
    cavok: false,
    wind: null,
    visibility: null,
    rvr: [],
    clouds: [],
    weather: [],
    temperature: null,
    qnh: null,
    remarks: null,
    unknownGroups: [],
    interpreted: true,
    raw,
    source: { ...source }
  };

  let cursor = 1;
  if (tokens[cursor] === 'COR') {
    report.correction = 'COR';
    cursor += 1;
  }
  if (!/^[A-Z]{4}$/.test(tokens[cursor] ?? '')) {
    throw new Error(`station identifier missing near token ${cursor}`);
  }
  report.station = tokens[cursor];
  cursor += 1;
  if (!/^\d{6}Z$/.test(tokens[cursor] ?? '')) {
    throw new Error(`observation day/time group missing near token ${cursor}`);
  }
  report.timeGroup = tokens[cursor];
  cursor += 1;

  if (tokens[cursor] === 'NIL') {
    report.status = 'nil';
    cursor += 1;
    if (tokens[cursor] !== undefined) {
      report.unknownGroups.push(field(tokens[cursor], { ...source, token: cursor },
        { reason: 'token after NIL' }));
      report.interpreted = false;
    }
    return report;
  }

  for (let index = cursor; index < tokens.length; index += 1) {
    const token = tokens[index];
    const tokenSource = { ...source, token: index };
    if (token === 'RMK') {
      report.remarks = tokens.slice(index + 1).join(' ');
      break;
    }
    const wind = parseWind(token, tokenSource);
    if (wind) { report.wind = wind; continue; }
    const visibility = parseVisibility(token, tokenSource);
    if (visibility) {
      if (token === 'CAVOK') report.cavok = true;
      report.visibility = visibility;
      continue;
    }
    const rvr = parseRvr(token, tokenSource);
    if (rvr) { report.rvr.push(rvr); continue; }
    const cloud = parseCloud(token, tokenSource);
    if (cloud) { report.clouds.push(cloud); continue; }
    if (WEATHER_RE.test(token)) {
      report.weather.push(field(token, tokenSource, { kind: 'weather', code: token }));
      continue;
    }
    const temperature = parseTemperature(token, tokenSource);
    if (temperature) { report.temperature = temperature; continue; }
    const qnh = parseQnh(token, tokenSource);
    if (qnh) { report.qnh = qnh; continue; }
    report.unknownGroups.push(field(token, tokenSource, { kind: 'unknown', reason: 'unrecognized group' }));
    report.interpreted = false;
  }
  return report;
}

// 仅依据来源传输窗口与电报内日时分（DDhhmmZ）确定完整 UTC 时刻，候选月份随窗口枚举，
// 绝不引用本机当前月份。窗口内出现多个合法时刻即 ambiguous，调用方应挂起待核对。
export function resolveObservationTime(timeGroup, window) {
  const match = /^(\d{2})(\d{2})(\d{2})Z$/.exec(timeGroup ?? '');
  if (!match) return { status: 'invalid', candidates: [] };
  const day = Number(match[1]);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const start = Date.parse(window[0]);
  const end = Date.parse(window[1]);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
    return { status: 'invalid-window', candidates: [] };
  }
  const candidates = [];
  const first = new Date(start);
  let year = first.getUTCFullYear();
  let month = first.getUTCMonth();
  for (let guard = 0; guard < 24; guard += 1) {
    const instant = Date.UTC(year, month, day, hour, minute, 0);
    const candidate = new Date(instant);
    const dayValid = candidate.getUTCFullYear() === year
      && candidate.getUTCMonth() === month
      && candidate.getUTCDate() === day;
    if (dayValid && instant >= start && instant <= end) {
      candidates.push(candidate.toISOString().replace(/\.\d{3}Z$/, 'Z'));
    }
    month += 1;
    if (month === 12) { month = 0; year += 1; }
    if (Date.UTC(year, month, 1) > end) break;
  }
  if (candidates.length === 0) return { status: 'outside-window', candidates: [] };
  if (candidates.length > 1) return { status: 'ambiguous', candidates };
  return { status: 'resolved', candidates };
}
