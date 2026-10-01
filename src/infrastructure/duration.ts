const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;

export function formatDuration(ms: number): string {
  if (ms % MS_PER_MINUTE === 0) return formatUnit(ms / MS_PER_MINUTE, 'minute');
  if (ms % MS_PER_SECOND === 0) return formatUnit(ms / MS_PER_SECOND, 'second');
  return formatUnit(ms, 'millisecond');
}

function formatUnit(value: number, unit: 'minute' | 'second' | 'millisecond'): string {
  return new Intl.NumberFormat('en', { style: 'unit', unit, unitDisplay: 'long' }).format(value);
}
