export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Tier = 'haiku' | 'sonnet' | 'opus'

export type Verdict =
  | { kind: 'pending' }
  | { kind: 'ready'; model: Tier; effort: Effort; reason: string }
  | { kind: 'failed' }

export type InUse = { model: string; effort: Effort | number | null }

declare module 'claude-code' {
  interface PluginState {
    'model-effort': { verdict: Verdict | null; inUse: InUse | null }
  }
}
