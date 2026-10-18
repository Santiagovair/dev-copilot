export type Bucket = { i: number; o: number; cr: number; cw: number; turns: number }
export type Usage = { days: Record<string, Record<string, Bucket>> }
export type Range = 'hoy' | '7d' | '30d' | 'todo'
export type Check = { at: string; ok: boolean; summary: string; errors: string[] } | null

declare module 'claude-code' {
  interface PluginState {
    'dev-copilot': { usage: Usage; range: Range; check: Check; router: boolean }
  }
}
