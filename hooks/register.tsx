import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Effort, InUse, Tier, Verdict } from '../types'

const verdictAtom = atom({ plugin: 'model-effort', key: 'verdict' } as const, null)
const inUseAtom = atom({ plugin: 'model-effort', key: 'inUse' } as const, null)

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus']

const EFFORT_LABEL: Record<Effort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'extra high',
  max: 'max',
}
const TIER_LABEL: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

const SYSTEM = `You are an advisor that decides which Claude model and which effort level a coding task needs in Claude Code.
Models, from least to most capable (and expensive):
- haiku: short questions, lookups, renames, one-line changes, explaining something simple, greetings.
- sonnet: most everyday work: implementing features, fixing clear bugs, tests, scoped refactors.
- opus: architecture or system design, hard bugs, large changes across many files, delicate reasoning.
Effort: low (fast, trivial), medium (normal), high (think it through), xhigh or max (very hard, only when really needed).
Pick the MINIMUM that does the task well.
Answer with a single line of JSON and nothing else:
{"model":"haiku|sonnet|opus","effort":"low|medium|high|xhigh|max","reason":"at most 12 words, in the same language as the task"}`

function tierOf(model: string): Tier | null {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('opus') || m.includes('fable')) return 'opus'
  return null
}

// "claude-opus-5-5[1m]" -> "Opus 5.5"
function prettyModel(id: string): string {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(id)
  if (!m || !m[1] || !m[2]) return id
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`
}

function parseVerdict(text: string): Verdict {
  const json = /\{[\s\S]*\}/.exec(text)
  if (!json) return { kind: 'failed' }
  try {
    const o = JSON.parse(json[0]) as { model?: unknown; effort?: unknown; reason?: unknown }
    const model = TIERS.find(t => t === o.model)
    const effort = EFFORTS.find(x => x === o.effort)
    if (!model || !effort) return { kind: 'failed' }
    return { kind: 'ready', model, effort, reason: typeof o.reason === 'string' ? o.reason : '' }
  } catch {
    return { kind: 'failed' }
  }
}

export const register: Register = on => {
  // Each prompt the person types is judged by Haiku in the background.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.text.trim().length === 0) return next(e)

    const task = e.text.slice(0, 4000)
    try {
      await update($, verdictAtom, () => ({ kind: 'pending' }))
    } catch {
      // never hold up the prompt over the band
    }
    $.clock.after(1, async () => {
      const r = await $.model.complete({
        model: 'haiku',
        system: SYSTEM,
        prompt: `Task:\n${task}`,
        effort: 'low',
        maxTokens: 200,
        timeoutMs: 20000,
      })
      const verdict: Verdict = r.isAnswered ? parseVerdict(r.text) : { kind: 'failed' }
      await update($, verdictAtom, () => verdict)
    })

    return next(e)
  })

  // The first request of each main turn says which model and effort are in use.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && e.index === 0) {
      const inUse: InUse = { model: e.model, effort: e.effort ?? null }
      await update($, inUseAtom, () => inUse)
    }
    return yield* next(e)
  })

  // The band just above the text box.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const verdict = await read($, verdictAtom)
    if (verdict === null) return next(e)

    const inUse = await read($, inUseAtom)
    const { Box, Text } = $.ui.resolve(e)

    if (verdict.kind === 'pending') {
      return (
        <Box>
          <Text dimColor>Checking which model this task needs…</Text>
        </Box>
      )
    }
    if (verdict.kind === 'failed') {
      return (
        <Box>
          <Text dimColor>Could not assess this task.</Text>
        </Box>
      )
    }

    const modelId = inUse?.model ?? (await $.session.model())
    const usedTier = tierOf(modelId)
    const usedEffort = typeof inUse?.effort === 'string' ? inUse.effort : null
    const usedText = `${prettyModel(modelId)}${usedEffort ? ` · ${EFFORT_LABEL[usedEffort]}` : ''}`
    const advice = `${TIER_LABEL[verdict.model]} · ${EFFORT_LABEL[verdict.effort]}`

    const dTier = usedTier ? TIERS.indexOf(usedTier) - TIERS.indexOf(verdict.model) : 0
    const dEffort = usedEffort ? EFFORTS.indexOf(usedEffort) - EFFORTS.indexOf(verdict.effort) : 0

    let icon: string
    let color: string
    let head: string
    if (dTier < 0 || (dTier === 0 && dEffort < 0)) {
      icon = '⚠'
      color = 'red'
      head = `Too light: you're on ${usedText}, ${advice} recommended`
    } else if (dTier > 0 || dEffort > 1) {
      icon = '💸'
      color = 'yellow'
      head = `Overkill: you're on ${usedText}, ${advice} would do`
    } else {
      icon = '✓'
      color = 'green'
      head = `Good fit: ${usedText} suits this task`
    }

    return (
      <Box flexDirection="column">
        <Text color={color}>
          {icon} {head}
        </Text>
        {verdict.reason ? <Text dimColor>   {verdict.reason}</Text> : null}
      </Box>
    )
  })
}
