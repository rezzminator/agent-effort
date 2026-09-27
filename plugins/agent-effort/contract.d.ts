/** A sub-agent's pin, by agent id: the effort each of its requests is sent at; null until pinned. */
export type AgentEffortPin = { level: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number | null };

declare module 'claude-code' {
  interface PluginState {
    'agent-effort': { pin: StateFamily<AgentEffortPin> };
  }
}
