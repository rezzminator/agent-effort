/** A sub-agent's pin, by agent id: the effort each of its requests is sent at; null until pinned. */
export type EffortControlPin = { level: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number | null };

declare module 'claude-code' {
  interface PluginState {
    'effort-live-control': { pin: StateFamily<EffortControlPin> };
  }
}
