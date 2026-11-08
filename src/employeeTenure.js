'use strict';
/**
 * 社員登録（入社）後の経過期間の計算。純粋関数のみ（外部アクセス・書込みなし）。
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD を厳密に解釈する。実在しない日付（2026-02-30等）は null。 */
function parseDate(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day, ms: date.getTime() };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function todayIso(now) {
  return now.toISOString().slice(0, 10);
}

/**
 * @param {string} hireDate 入社日（YYYY-MM-DD）
 * @param {string} [asOf] 基準日（YYYY-MM-DD）。省略時は実行日（UTC）
 * @param {Date} [now] テスト用の現在時刻
 */
function calculateEmployeeTenure(hireDate, asOf, now = new Date()) {
  const hire = parseDate(hireDate);
  if (!hire) return { error: 'hireDateはYYYY-MM-DD形式の実在する日付である必要があります' };
  const asOfValue = asOf === undefined ? todayIso(now) : asOf;
  const ref = parseDate(asOfValue);
  if (!ref) return { error: 'asOfはYYYY-MM-DD形式の実在する日付である必要があります' };

  const base = { hireDate, asOf: asOfValue };
  if (ref.ms < hire.ms) {
    return {
      ...base,
      status: '入社前',
      totalDays: 0,
      daysUntilHire: Math.round((hire.ms - ref.ms) / 86400000),
      years: 0,
      months: 0,
      days: 0,
      label: '入社前'
    };
  }

  // 入社日に整数か月を足した「記念日」（存在しない日は月末に丸める）が基準日以前となる最大の月数を求める
  const anchorMs = (m) => {
    const index = hire.year * 12 + (hire.month - 1) + m;
    const y = Math.floor(index / 12);
    const mo = index % 12;
    return Date.UTC(y, mo, Math.min(hire.day, daysInMonth(y, mo + 1)));
  };
  let totalMonths = (ref.year - hire.year) * 12 + (ref.month - hire.month);
  if (anchorMs(totalMonths) > ref.ms) totalMonths -= 1;
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  const days = Math.round((ref.ms - anchorMs(totalMonths)) / 86400000);

  const totalDays = Math.round((ref.ms - hire.ms) / 86400000);
  const parts = [];
  if (years > 0) parts.push(`${years}年`);
  if (months > 0) parts.push(`${months}か月`);
  if (days > 0 || parts.length === 0) parts.push(`${days}日`);
  return {
    ...base,
    status: '在籍',
    totalDays,
    years,
    months,
    days,
    label: parts.join('')
  };
}

module.exports = { calculateEmployeeTenure, parseDate };
