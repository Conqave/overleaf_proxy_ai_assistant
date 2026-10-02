export const ContextPressure = {
  Low: 'low',
  Elevated: 'elevated',
  High: 'high',
} as const;
export type ContextPressure = (typeof ContextPressure)[keyof typeof ContextPressure];

const CONTEXT_PRESSURES: readonly string[] = Object.values(ContextPressure);

export function isContextPressure(value: unknown): value is ContextPressure {
  return typeof value === 'string' && CONTEXT_PRESSURES.includes(value);
}

export interface ContextUsage {
  readonly contextTokens: number;
  readonly pressure: ContextPressure;
  readonly promptTokens: number;
}
