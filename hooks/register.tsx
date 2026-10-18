import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Bucket, Range, Usage } from '../types'

const PANE = 'dev-copilot'
const TZ_OFFSET_MS = -3 * 3600 * 1000 // Argentina, UTC-3

const usage = atom({ plugin: 'dev-copilot', key: 'usage' } as const, { days: {} } as Usage)
const range = atom({ plugin: 'dev-copilot', key: 'range' } as const, '7d' as Range)
const check = atom({ plugin: 'dev-copilot', key: 'check' } as const, null)
const router = atom({ plugin: 'dev-copilot', key: 'router' } as const, true)

// USD por millón de tokens (precios de lista aproximados; son una ESTIMACIÓN).
const PRICES: Record<string, { i: number; o: number }> = {
  haiku: { i: 1, o: 5 },
  sonnet: { i: 3, o: 15 },
  opus: { i: 5, o: 25 },
  otro: { i: 3, o: 15 },
}
const family = (id: string) =>
  /haiku/i.test(id) ? 'haiku' : /opus/i.test(id) ? 'opus' : /sonnet/i.test(id) ? 'sonnet' : 'otro'

const cost = (family: string, b: Bucket) => {
  const p = PRICES[family] ?? PRICES.otro
  return (
    (b.i * p.i + b.o * p.o + b.cr * p.i * 0.1 + b.cw * p.i * 1.25) / 1_000_000
  )
}

const dayKey = (ms: number) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10)
const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n))
const usd = (n: number) => `US$${n.toFixed(n < 1 ? 3 : 2)}`

const emptyBucket = (): Bucket => ({ i: 0, o: 0, cr: 0, cw: 0, turns: 0 })

// ---- agregación por rango ----
const inRange = (key: string, r: Range, now: number) => {
  if (r === 'todo') return true
  if (r === 'hoy') return key === dayKey(now)
  const days = r === '7d' ? 7 : 30
  return key >= dayKey(now - (days - 1) * 86_400_000)
}

const summarize = (u: Usage, r: Range, now: number) => {
  const byModel: Record<string, Bucket> = {}
  for (const [key, models] of Object.entries(u.days)) {
    if (!inRange(key, r, now)) continue
    for (const [m, b] of Object.entries(models)) {
      const t = (byModel[m] ??= emptyBucket())
      t.i += b.i; t.o += b.o; t.cr += b.cr; t.cw += b.cw; t.turns += b.turns
    }
  }
  const total = emptyBucket()
  let totalCost = 0
  const costs: Record<string, number> = {}
  for (const [m, b] of Object.entries(byModel)) {
    total.i += b.i; total.o += b.o; total.cr += b.cr; total.cw += b.cw; total.turns += b.turns
    costs[m] = cost(m, b)
    totalCost += costs[m]
  }
  return { byModel, costs, total, totalCost }
}

// ---- recomendaciones según el uso real ----
const recommend = (u: Usage, r: Range, now: number): string[] => {
  const s = summarize(u, r, now)
  const out: string[] = []
  if (s.total.turns < 3) return ['Todavía hay pocos datos. Usá Claude un rato y acá aparecen recomendaciones.']

  const inputAll = s.total.i + s.total.cr + s.total.cw
  const hit = inputAll > 0 ? s.total.cr / inputAll : 0
  if (hit < 0.5)
    out.push(`Solo el ${Math.round(hit * 100)}% de la entrada vino del caché. Evitá cambiar de modelo a mitad de conversación y no abras sesiones nuevas para cosas chicas: el caché es lo que más abarata.`)

  const opusCost = s.costs.opus ?? 0
  if (s.totalCost > 0 && opusCost / s.totalCost > 0.6)
    out.push(`Opus es el ${Math.round((opusCost / s.totalCost) * 100)}% de tu gasto. Dejá Opus para arquitectura y bugs difíciles; cambios chicos (estilos, textos, renombres) hacelos con Sonnet o Haiku.`)

  const avgOut = s.total.o / s.total.turns
  if (avgOut > 3000)
    out.push(`Cada turno genera ~${fmt(avgOut)} tokens de salida. Pedí respuestas más cortas o "solo mostrame el diff" cuando no necesites explicación.`)

  const avgIn = inputAll / s.total.turns
  if (avgIn > 150_000)
    out.push(`El contexto promedio es de ${fmt(avgIn)} tokens por turno. Usá /compact o arrancá una conversación nueva al cambiar de tarea.`)

  // hoy vs. promedio de los 7 días anteriores
  const today = summarize(u, 'hoy', now).totalCost
  const week = summarize(u, '7d', now)
  const prevAvg = (week.totalCost - today) / 6
  if (prevAvg > 0 && today > prevAvg * 2)
    out.push(`Hoy llevás ${usd(today)}, más del doble de tu promedio diario reciente (${usd(prevAvg)}).`)

  if (out.length === 0) out.push('Tu uso se ve eficiente: buen aprovechamiento del caché y gasto repartido. Seguí así.')
  return out
}

// ---- router de tareas ----
type Level = 'rapido' | 'equilibrado' | 'profundo'
const SIMPLE = /\b(renombr|typo|errata|ortograf|traduc|comentari|formate|indent|color|texto|label|etiqueta|log|explic[aá] (qu[eé]|esto)|qu[eé] hace|resum|list[aá]|busc[aá]|git (status|log|diff))/i
const HARD = /\b(arquitectur|dise[nñ][aá] (el|la|un)|refactor|migraci[oó]n|seguridad|vulnerab|race condition|concurren|performance|optimiz|multi-?tenant|esquema|schema|planific|todo el proyecto|autenticaci[oó]n|pagos?|webhook)/i

const classify = (text: string): Level => {
  if (HARD.test(text) || text.length > 1200) return 'profundo'
  if (SIMPLE.test(text) && text.length < 280) return 'rapido'
  return 'equilibrado'
}
const AGENT: Record<Level, { type: string; model: string }> = {
  rapido: { type: 'dev-copilot:rapido', model: 'haiku' },
  equilibrado: { type: 'dev-copilot:equilibrado', model: 'sonnet' },
  profundo: { type: 'dev-copilot:profundo', model: 'opus' },
}
const RANK: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2, otro: 1 }

// ---- guardia ----
const DANGEROUS: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~|\*|\.\s|\.$|\$HOME)/, 'borrado recursivo de raíz, home o carpeta actual'],
  [/\bgit\s+push\b.*(--force\b|\s-f\b)(?!-with-lease)/, 'git push --force'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard (pierde cambios sin commitear)'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git clean -f (borra archivos sin trackear)'],
  [/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i, 'sentencia SQL destructiva'],
  [/\bdelete\s+from\s+\w+\s*(;|$)/i, 'DELETE sin WHERE'],
  [/\bprisma\s+(migrate\s+reset|db\s+push\s+.*--force-reset)/, 'prisma reset (borra toda la base)'],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, 'ejecutar un script descargado sin revisarlo'],
  [/\bchmod\s+-R\s+777\b/, 'chmod -R 777'],
]
const PROTECTED_FILE = /(^|\/)(\.env(\.(?!example|sample|template)[^/]*)?|id_rsa|id_ed25519|.*\.pem)$|(^|\/)\.git\//
const CODE_FILE = /\.(ts|tsx|js|jsx|mts|cts)$/

let dirty = false

async function runCheck($: any) {
  if (!(await $.fs.exists('tsconfig.json'))) return
  $.ui.status('tsc verificando…')
  const when = new Date(await $.clock.now() + TZ_OFFSET_MS).toISOString().slice(11, 16)
  try {
    const r = await $.process.run(['npx', '--no-install', 'tsc', '--noEmit', '--pretty', 'false'], { timeoutMs: 90_000 })
    const errors = String(r.stdout).split('\n').filter((l: string) => /error TS\d+/.test(l))
    const ok = r.exitCode === 0
    await update($, check, () => ({
      at: when, ok,
      summary: ok ? 'tsc sin errores' : `tsc: ${errors.length} error(es)`,
      errors: errors.slice(0, 8),
    }))
    $.ui.status(ok ? undefined : `tsc: ${errors.length} error(es) — /copiloto`)
    if (!ok) $.ui.toast(`TypeScript: ${errors.length} error(es). Mirá el panel /copiloto`)
  } catch {
    $.ui.status(undefined)
  }
}

function guardFile($: any, e: any, next: any) {
  const p = String(e.file_path ?? '')
  if (PROTECTED_FILE.test(p)) return { deny: `dev-copilot: ${p} está protegido (secretos / .git).` }
  if (CODE_FILE.test(p)) dirty = true
  return next(e)
}
function failClosed($: any, e: any, next: any) {
  return next.called ? next(e) : { deny: 'dev-copilot: la guardia falló, bloqueado por seguridad.' }
}

export const register: Register = on => {
  let level: Level | null = null

  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get('usage')) as Usage | undefined
    if (saved?.days) await update($, usage, () => saved)
    const r = await $.store.get('router')
    if (typeof r === 'boolean') await update($, router, () => r)

    await $.command.register({
      name: 'copiloto',
      description: 'Panel de tokens. Uso: /copiloto [panel | check | router on|off]',
    })
    await $.agent.register({
      name: 'rapido',
      description: 'Tareas simples y baratas: renombrar, cambiar textos o estilos, buscar, explicar código corto.',
      model: 'haiku',
      prompt: 'Sos un asistente de desarrollo rápido y conciso. Hacé exactamente lo pedido con el menor cambio posible y respondé en español, breve.',
    })
    await $.agent.register({
      name: 'equilibrado',
      description: 'Tareas normales de desarrollo: implementar features, arreglar bugs comunes, escribir tests.',
      model: 'sonnet',
      prompt: 'Sos un desarrollador full-stack senior (Next.js, React, Node, PostgreSQL, Tailwind). Resolvé la tarea con código limpio y respondé en español.',
    })
    await $.agent.register({
      name: 'profundo',
      description: 'Tareas difíciles: arquitectura, refactors grandes, seguridad, bugs complejos, diseño de base de datos.',
      model: 'opus',
      prompt: 'Sos un arquitecto de software. Analizá en profundidad, considerá alternativas y riesgos antes de cambiar código, y respondé en español.',
    })
    return next(e)
  })

  // ---- 1) contar tokens ----
  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (u) {
      const now = await $.clock.now()
      const key = dayKey(now)
      const fam = family(u.model)
      const updated = await update($, usage, cur => {
        const days = { ...cur.days }
        const models = { ...(days[key] ?? {}) }
        const b = { ...(models[fam] ?? emptyBucket()) }
        b.i += u.input_tokens; b.o += u.output_tokens
        b.cr += u.cache_read_input_tokens; b.cw += u.cache_creation_input_tokens
        b.turns += 1
        models[fam] = b
        days[key] = models
        return { days }
      })
      await $.store.set('usage', updated)
    }
    // ---- 3) verificación automática tras editar código ----
    const result = await next(e)
    if (dirty && !e.agentId) {
      dirty = false
      void runCheck($)
    }
    return result
  })

  // ---- 2) router calidad-precio ----
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.origin?.kind && e.origin.kind !== 'user') return next(e)
    if (!(await read($, router))) return next(e)

    level = classify(e.text)
    const current = family(await $.session.model())
    const target = AGENT[level]
    const diff = RANK[target.model] - (RANK[current] ?? 1)
    $.ui.status(`router: ${level} (${target.model})`)
    if (diff === 0) return next(e)

    const why = diff < 0
      ? `Esta tarea parece simple y la sesión corre en un modelo más caro (${current}). Para ahorrar, delegá la tarea completa con la herramienta Agent al tipo "${target.type}".`
      : `Esta tarea parece compleja y la sesión corre en un modelo más liviano (${current}). Para mejor calidad, delegá la parte difícil con la herramienta Agent al tipo "${target.type}".`
    return next({ ...e, context: [...(e.context ?? []), `[dev-copilot] ${why}`] })
  }).catch(($, e, next) => next(e))

  // ---- 4) guardia ----
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const cmd = String((e as any).command ?? '')
    for (const [re, label] of DANGEROUS)
      if (re.test(cmd)) return { deny: `dev-copilot bloqueó: ${label}. Si de verdad lo querés, ejecutalo vos a mano.` }
    return next(e)
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'dev-copilot: la guardia falló, bloqueado por seguridad.' },
  )

  on('tool.call', { tool: 'Edit' }, guardFile).catch(failClosed)
  on('tool.call', { tool: 'Write' }, guardFile).catch(failClosed)
  on('tool.call', { tool: 'MultiEdit' }, guardFile).catch(failClosed)

  // ---- comandos ----
  on('command.run', { command: 'copiloto' }, async ($, e) => {
    const [sub, arg] = e.args.trim().split(/\s+/)
    if (sub === 'router') {
      const on_ = arg !== 'off'
      await update($, router, () => on_)
      await $.store.set('router', on_)
      return { text: `Router de agentes ${on_ ? 'activado' : 'desactivado'}.` }
    }
    if (sub === 'check') {
      await runCheck($)
      return { text: 'Verificación lanzada; el resultado aparece en el panel.' }
    }
    await $.ui.open({ id: PANE, title: 'Copiloto' })
    return { text: 'Panel abierto.' }
  })

  // ---- panel ----
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const u = await read($, usage)
    const r = await read($, range)
    const chk = await read($, check)
    const rt = await read($, router)
    const now = await $.clock.now()
    const s = summarize(u, r, now)
    const recs = recommend(u, r, now)
    const labels: Record<Range, string> = { hoy: 'Hoy', '7d': '7 días', '30d': '30 días', todo: 'Todo' }

    return (
      <Box flexDirection="column" gap={1}>
        <Box>
          {(Object.keys(labels) as Range[]).map(k => (
            <Button key={k} label={r === k ? `[${labels[k]}]` : labels[k]} onPress={() => update($, range, () => k)} />
          ))}
        </Box>

        <Box flexDirection="column">
          <Text weight="bold">Total ({labels[r]}): {fmt(s.total.i + s.total.o + s.total.cr + s.total.cw)} tokens · {usd(s.totalCost)} est.</Text>
          <Text dimColor>entrada {fmt(s.total.i)} · salida {fmt(s.total.o)} · caché leído {fmt(s.total.cr)} · caché escrito {fmt(s.total.cw)} · {s.total.turns} turnos</Text>
          {Object.entries(s.byModel).map(([m, b]) => (
            <Text key={m}>{m}: {fmt(b.i + b.o + b.cr + b.cw)} tokens, {b.turns} turnos, {usd(s.costs[m])}</Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text weight="bold">Recomendaciones</Text>
          {recs.map((t, i) => <Text key={String(i)}>• {t}</Text>)}
        </Box>

        <Box flexDirection="column">
          <Text weight="bold">Verificación de código</Text>
          {chk === null
            ? <Text dimColor>Sin datos todavía (corre sola al editar archivos .ts/.tsx).</Text>
            : <Text color={chk.ok ? 'green' : 'red'}>{chk.at} — {chk.summary}</Text>}
          {chk?.errors.map((l, i) => <Text key={String(i)} dimColor>{l.slice(0, 110)}</Text>)}
        </Box>

        <Box>
          <Text dimColor>Router de agentes: {rt ? 'activo' : 'apagado'} </Text>
          <Button key="rt" label={rt ? 'Apagar' : 'Activar'} onPress={async () => {
            await update($, router, v => !v)
            await $.store.set('router', !rt)
          }} />
        </Box>
      </Box>
    )
  })
}
