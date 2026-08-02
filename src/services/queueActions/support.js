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
