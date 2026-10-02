export const ContextPressure = {
  Low: 'low',
  Elevated: 'elevated',
  High: 'high',
} as const;
export type ContextPressure = (typeof ContextPressure)[keyof typeof ContextPressure];

export interface ContextUsage {
  readonly contextTokens: number;
  readonly pressure: ContextPressure;
  readonly promptTokens: number;
}
