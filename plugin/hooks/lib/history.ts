// Import do histórico de transcripts do Claude Code (~/.claude/projects/**/*.jsonl): custo por chamada de API,
// faixa de contexto e causa de cada reescrita grande de cache. Funções puras; quem lê os arquivos é o register.
//
// $.fs.read e a saída de $.process.run param em 4 MiB, e um transcript passa fácil de 100 MB. Por isso os
// arquivos grandes passam por um extrator do sistema (awk no Unix, PowerShell no Windows) que devolve uma
// linha curta por chamada; os pequenos podem ser lidos e analisados aqui mesmo com JSON.parse.

import { emptyDay, dayKey } from './ledger.ts'
import type { Day } from './ledger.ts'
import { contextBand, priceFor } from './pricing.ts'

export type CallRecord = {
  kind: 'call'
  id: string
  model: string
  ts: number
  side: boolean
  input: number
  cw: number
  cr: number
  out: number
  // Escritas de cache por TTL, quando o transcript traz (`usage.cache_creation`)
  cw1h: number | null
  cw5m: number | null
}

export type CompactMark = { kind: 'compact'; ts: number }

export type TranscriptEvent = CallRecord | CompactMark

/** Uma chamada aparece em várias linhas (uma por bloco de conteúdo): fica a de maior output, a completa. */
function keepLargest(events: TranscriptEvent[]): TranscriptEvent[] {
  const calls = new Map<string, CallRecord>()
  const marks: TranscriptEvent[] = []
  for (const ev of events) {
    if (ev.kind === 'compact') marks.push(ev)
    else {
      const prev = calls.get(ev.id)
      if (!prev || ev.out >= prev.out) calls.set(ev.id, ev)
    }
  }
  return [...marks, ...calls.values()]
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Transcript inteiro (arquivo pequeno), linha a linha com JSON.parse. Linhas inválidas são ignoradas. */
export function parseJsonlText(text: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const ts = Date.parse(String(row.timestamp ?? ''))
    if (!Number.isFinite(ts)) continue
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      events.push({ kind: 'compact', ts })
      continue
    }
    const message = row.message as Record<string, unknown> | undefined
    const usage = message?.usage as Record<string, unknown> | undefined
    const id = String(message?.id ?? '')
    if (row.type !== 'assistant' || !usage || !id.startsWith('msg_')) continue
    const creation = usage.cache_creation as Record<string, unknown> | undefined
    events.push({
      kind: 'call',
      id,
      model: String(message?.model ?? ''),
      ts,
      side: row.isSidechain === true,
      input: num(usage.input_tokens),
      cw: num(usage.cache_creation_input_tokens),
      cr: num(usage.cache_read_input_tokens),
      out: num(usage.output_tokens),
      cw1h: creation ? num(creation.ephemeral_1h_input_tokens) : null,
      cw5m: creation ? num(creation.ephemeral_5m_input_tokens) : null,
    })
  }
  return keepLargest(events)
}

/**
 * Saída dos extratores: `A\tid\tmodelo\ttimestamp\tsidechain\tinput\tcw\tcr\toutput\tcw1h\tcw5m` por chamada e
 * `C\ttimestamp` por compactação. Linhas fora do formato são ignoradas.
 */
export function parseExtract(text: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = []
  for (const line of text.split(/\r?\n/)) {
    const f = line.split('\t')
    if (f[0] === 'C' && f.length >= 2) {
      const ts = Date.parse(f[1])
      if (Number.isFinite(ts)) events.push({ kind: 'compact', ts })
      continue
    }
    if (f[0] !== 'A' || f.length < 11 || !f[1].startsWith('msg_')) continue
    const ts = Date.parse(f[3])
    if (!Number.isFinite(ts)) continue
    const int = (s: string) => (/^\d+$/.test(s) ? Number(s) : 0)
    events.push({
      kind: 'call',
      id: f[1],
      model: f[2],
      ts,
      side: f[4] === '1',
      input: int(f[5]),
      cw: int(f[6]),
      cr: int(f[7]),
      out: int(f[8]),
      cw1h: /^\d+$/.test(f[9]) ? Number(f[9]) : null,
      cw5m: /^\d+$/.test(f[10]) ? Number(f[10]) : null,
    })
  }
  return keepLargest(events)
}

// Extrator POSIX: uma linha por chamada (a de maior output) e uma por compactação. Recebe o arquivo como argv.
export const AWK_EXTRACT = `
function after(s, key,   v) { if (match(s, key "[0-9]+")) return substr(s, RSTART + length(key), RLENGTH - length(key)); return "" }
function lastts(s,   t) {
  t = ""
  while (match(s, /"timestamp":"[^"]*"/)) { t = substr(s, RSTART + 13, RLENGTH - 14); s = substr(s, RSTART + RLENGTH) }
  return t
}
{
  if (index($0, "\\"subtype\\":\\"compact_boundary\\"")) { t = lastts($0); if (t != "") print "C\\t" t; next }
  u = index($0, "\\"usage\\":{\\"input_tokens\\":")
  if (!u) next
  if (!match($0, /"id":"msg_[^"]*"/)) next
  id = substr($0, RSTART + 6, RLENGTH - 7)
  model = ""
  if (match($0, /"message":[{]"model":"[^"]*"/)) model = substr($0, RSTART + 20, RLENGTH - 21)
  else if (match($0, /"model":"[^"]*"/)) model = substr($0, RSTART + 9, RLENGTH - 10)
  us = substr($0, u)
  out = after(us, "\\"output_tokens\\":") + 0
  if ((id in best) && best[id] > out) next
  best[id] = out
  side = index($0, "\\"isSidechain\\":true") ? 1 : 0
  rec[id] = "A\\t" id "\\t" model "\\t" lastts($0) "\\t" side "\\t" after(us, "\\"input_tokens\\":") "\\t" \\
    after(us, "\\"cache_creation_input_tokens\\":") "\\t" after(us, "\\"cache_read_input_tokens\\":") "\\t" out "\\t" \\
    after(us, "\\"ephemeral_1h_input_tokens\\":") "\\t" after(us, "\\"ephemeral_5m_input_tokens\\":")
}
END { for (id in rec) print rec[id] }
`

/** Extrator do Windows (PowerShell 5.1+), mesma saída do awk, lendo o arquivo em streaming. */
export function powershellExtract(path: string): string {
  const quoted = `'${path.replace(/'/g, "''")}'`
  return `
$ErrorActionPreference = 'Stop'
$best = @{}
$marks = New-Object System.Collections.Generic.List[string]
function After([string]$s, [string]$key) {
  $m = [regex]::Match($s, [regex]::Escape($key) + '([0-9]+)')
  if ($m.Success) { return $m.Groups[1].Value } else { return '' }
}
function LastTs([string]$l) {
  $i = $l.LastIndexOf('"timestamp":"')
  if ($i -lt 0) { return '' }
  $s = $i + 13
  $e = $l.IndexOf('"', $s)
  if ($e -lt 0) { return '' }
  return $l.Substring($s, $e - $s)
}
foreach ($l in [System.IO.File]::ReadLines(${quoted})) {
  if ($l.Contains('"subtype":"compact_boundary"')) { $t = LastTs $l; if ($t) { $marks.Add("C\`t$t") }; continue }
  $u = $l.IndexOf('"usage":{"input_tokens":')
  if ($u -lt 0) { continue }
  $m = [regex]::Match($l, '"id":"(msg_[^"]*)"')
  if (-not $m.Success) { continue }
  $id = $m.Groups[1].Value
  $mm = [regex]::Match($l, '"message":\\{"model":"([^"]*)"')
  if (-not $mm.Success) { $mm = [regex]::Match($l, '"model":"([^"]*)"') }
  $model = if ($mm.Success) { $mm.Groups[1].Value } else { '' }
  $us = $l.Substring($u)
  $o = After $us '"output_tokens":'
  $out = if ($o) { [long]$o } else { 0 }
  if ($best.ContainsKey($id) -and $best[$id].Out -gt $out) { continue }
  $side = if ($l.Contains('"isSidechain":true')) { '1' } else { '0' }
  $ts = LastTs $l
  $inp = After $us '"input_tokens":'
  $cw = After $us '"cache_creation_input_tokens":'
  $cr = After $us '"cache_read_input_tokens":'
  $c1 = After $us '"ephemeral_1h_input_tokens":'
  $c5 = After $us '"ephemeral_5m_input_tokens":'
  $line = "A\`t$id\`t$model\`t$ts\`t$side\`t$inp\`t$cw\`t$cr\`t$out\`t$c1\`t$c5"
  $best[$id] = @{ Out = $out; Line = $line }
}
foreach ($t in $marks) { [Console]::Out.WriteLine($t) }
foreach ($v in $best.Values) { [Console]::Out.WriteLine($v.Line) }
`
}

/** Hash curto (FNV-1a 32 bits) para lembrar ids já importados sem guardar o id inteiro. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export type AggregateOptions = {
  mainTtlMinutes: number
  subTtlMinutes: number
  // Só registros anteriores a isto entram (dali em diante, o ledger ao vivo já contou)
  liveSince: number
  // Arquivo de subagente (…/subagents/*.jsonl): tudo nele é subagente
  isSubFile: boolean
}

export type AggregateResult = { days: Record<string, Day>; calls: number; first: number; last: number }

const MISS_THRESHOLD = 100_000

/**
 * Soma os eventos de um arquivo por dia. `seen` (hashes de ids) evita contar duas vezes a mesma chamada,
 * que se repete em sessões retomadas ou bifurcadas; quem chama guarda o conjunto entre arquivos.
 */
export function aggregate(events: TranscriptEvent[], opts: AggregateOptions, seen: Set<string>): AggregateResult {
  const days: Record<string, Day> = {}
  const sorted = [...events].sort((a, b) => a.ts - b.ts || (a.kind === 'compact' ? -1 : 1))
  let lastTs = 0
  let lastModel = ''
  let compacted = false
  let calls = 0
  let first = 0
  let last = 0
  for (const ev of sorted) {
    if (ev.kind === 'compact') {
      if (!opts.isSubFile) compacted = true
      continue
    }
    const isSub = opts.isSubFile || ev.side
    const ttlMinutes = (ev.cw1h ?? 0) > 0 ? 60 : (ev.cw5m ?? 0) > 0 ? 5 : isSub ? opts.subTtlMinutes : opts.mainTtlMinutes
    const p = priceFor(ev.model)
    const writeCost = p
      ? ev.cw1h !== null && ev.cw5m !== null && ev.cw1h + ev.cw5m > 0
        ? ev.cw1h * p.write1h + ev.cw5m * p.write5m
        : ev.cw * (ttlMinutes >= 60 ? p.write1h : p.write5m)
      : 0
    const cost = p ? (ev.input * p.input + writeCost + ev.cr * p.read + ev.out * p.output) / 1e6 : null

    // A causa usa o estado anterior desta mesma linha do tempo (conversa principal ou subagente do arquivo)
    let cause: 'rebuild' | 'idle' | 'model' | 'other' | null = null
    if (ev.cw > MISS_THRESHOLD && !(ev.side && !opts.isSubFile)) {
      cause = compacted ? 'rebuild'
        : lastTs && ev.ts - lastTs > ttlMinutes * 60_000 ? 'idle'
          : lastModel && lastModel !== ev.model ? 'model'
            : lastTs ? 'other'
              : null // primeira chamada do arquivo: o cache ainda não existia
    }
    if (!(ev.side && !opts.isSubFile)) {
      lastTs = ev.ts
      lastModel = ev.model
      compacted = false
    }

    const hash = fnv1a(ev.id)
    if (ev.ts >= opts.liveSince || seen.has(hash)) continue
    seen.add(hash)
    calls += 1
    first = first ? Math.min(first, ev.ts) : ev.ts
    last = Math.max(last, ev.ts)
    const key = dayKey(ev.ts)
    const day = (days[key] ??= emptyDay())
    const missCost = writeCost / 1e6
    if (isSub) {
      day.subCalls += 1
      if (cost === null) day.unpriced += 1
      else day.subCost += cost
      if (cause && cause !== 'rebuild') {
        day.subMisses += 1
        day.subMissCost += missCost
      }
      continue
    }
    const ctx = ev.input + ev.cw + ev.cr
    day.calls += 1
    if (cost === null) day.unpriced += 1
    else {
      day.cost += cost
      day[`band${contextBand(ctx)}`] += cost
    }
    day.read += ev.cr
    day.write += ev.cw
    day.output += ev.out
    day.ctxSum += ctx
    day.maxCtx = Math.max(day.maxCtx, ctx)
    if (cause === 'rebuild') { day.rebuilds += 1; day.rebuildCost += missCost }
    if (cause === 'idle') { day.missIdle += 1; day.missIdleCost += missCost }
    if (cause === 'model') { day.missModel += 1; day.missModelCost += missCost }
    if (cause === 'other') { day.missOther += 1; day.missOtherCost += missCost }
  }
  return { days, calls, first, last }
}
