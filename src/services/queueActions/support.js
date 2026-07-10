export const valid = () => ({ valid: true });
export const invalid = (reason) => ({ valid: false, reason });

export const parseDate = (input) => {
  if (!input) return null;
  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const formatDiscordTime = (date, style = 'R') => {
  const parsed = parseDate(date);
  if (!parsed) return 'Unknown';
  return `<t:${Math.floor(parsed.getTime() / 1000)}:${style}>`;
};

export const formatNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(numeric)
    : '—';
};

export const formatMilitaryMultiline = (military = {}) =>
  [
    `🪖 Soldiers: ${formatNumber(military?.soldiers)}`,
    `🛡️ Tanks: ${formatNumber(military?.tanks)}`,
    `✈️ Aircraft: ${formatNumber(military?.aircraft)}`,
    `🚢 Ships: ${formatNumber(military?.ships)}`,
    `🕵️ Spies: ${formatNumber(military?.spies)}`,
    `🎯 Missiles: ${formatNumber(military?.missiles)}`,
    `☢️ Nukes: ${formatNumber(military?.nukes)}`,
  ].join('\n');

export const chunkDiscordMessage = (text, maxLength = 1900) => {
  if (typeof text !== 'string' || text.length <= maxLength) return [text];

  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (!line) continue;
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (line.length > maxLength) {
      for (let index = 0; index < line.length; index += maxLength) {
        chunks.push(line.slice(index, index + maxLength));
      }
      current = '';
    } else {
      current = line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
};
