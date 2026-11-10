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

const SYSTEM = `You are an advisor that decides which Claude model and which effort level the user's latest request needs in Claude Code.
You are shown the recent conversation for context, then the latest request. Judge the WORK the request leads to, not how short the message is: "ok, do it" or "create the video" can be a big job.
Models, from least to most capable (and expensive):
- haiku: ONLY pure questions and lookups, greetings, explaining something simple, a rename or one-line edit. No files to create, no commands to run, nothing to debug.
- sonnet: any real agentic work: creating or editing files, running commands, tests, builds, scripts, debugging, multi-step tasks, scoped refactors, building a small tool or video. This is the right default for most coding work.
- opus: architecture or system design, very hard or subtle bugs, large changes across many files, delicate reasoning where a mistake is costly.
Effort: low (trivial and fast), medium (normal), high (think it through), xhigh or max (very hard, only when really needed).
Pick the cheapest model that will do the whole task well and reliably on the first try. Do not pick haiku if the task needs tools, several steps or debugging.
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

type Row = { role: 'user' | 'assistant'; text: string; toolUses: readonly { tool: string }[] }

// The last few messages as plain text, with a count of the tools the assistant used.
function recentContext(rows: readonly Row[]): string {
  const lines: string[] = []
  for (const row of rows.slice(-8)) {
    const text = row.text.replace(/\s+/g, ' ').trim().slice(0, 500)
    const tools = new Map<string, number>()
    for (const use of row.toolUses) tools.set(use.tool, (tools.get(use.tool) ?? 0) + 1)
    const used = [...tools].map(([name, n]) => `${name} x${n}`).join(', ')
    if (text === '' && used === '') continue
    lines.push(`${row.role}: ${text}${used ? ` [tools: ${used}]` : ''}`)
  }
  return lines.join('\n')
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
      let context = ''
      try {
        context = recentContext(await $.session.messages())
      } catch {
        // judge the message alone if the transcript cannot be read
      }
      const r = await $.model.complete({
        model: 'haiku',
        system: SYSTEM,
        prompt: `${context ? `Recent conversation:\n${context}\n\n` : ''}Latest request:\n${task}`,
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
