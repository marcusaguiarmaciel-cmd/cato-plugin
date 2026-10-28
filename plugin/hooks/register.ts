// CATO como mod do Claude Code: tudo roda dentro do Claude Code, sem Python e sem processo por hook.
//
// O que pesa na fatura (medido em transcripts reais): o contexto relido a cada turno e as reescritas de
// cache quando o TTL expira. Por isso o centro do CATO é o guard de contexto/cache, o status com o custo
// do próximo turno e a autocompactação; a compressão de saídas e o bloqueio de leituras pesadas vêm junto.

import type { EngineInterface, Register } from 'claude-code'

import { bm25Search, buildRepoMap, chunkLines, extractSymbol, IGNORED_DIRS, isCodeFile } from './lib/codeintel.ts'
import type { SandboxChunk } from './lib/codeintel.ts'
import { ERROR_SIGNAL_RE, estimateTokens, isCompressibleCommand, optimizeOutput } from './lib/compress.ts'
import { contextTokens, priceFor, usageCost, usd } from './lib/pricing.ts'
import type { StepUsage } from './lib/pricing.ts'

type Options = {
  guard: boolean
  guardBlockUsd: number
  contextWarn: string
  cacheTtlMinutes: number
  autoCompactPercent: number
  blockHeavyReads: boolean
  compressShell: boolean
  disableForks: boolean
  pythonChecks: boolean
}

type Day = {
  calls: number
  cost: number
  read: number
  write: number
  output: number
  ctxSum: number
  maxCtx: number
  missIdle: number
  missIdleCost: number
  missModel: number
  missModelCost: number
  missOther: number
  missOtherCost: number
  compressions: number
  compressedTokens: number
  blockedReads: number
  guardHolds: number
}

type Ledger = { days: Record<string, Day> }

const LEDGER_KEY = 'ledger'
const MISS_THRESHOLD = 100_000
const IDLE_MIN_CONTEXT = 150_000
const COMPACT_SUMMARY_TOKENS = 15_000
const LEDGER_DAYS = 90
const RAW_FILE_DAYS = 14

// Leituras que só enchem o contexto (o equivalente às regras `deny` de Read que o CATO instalava)
const HEAVY_DIR_RE = /(^|[\\/])(node_modules|dist|build|coverage|\.next|target|\.venv|venv)([\\/]|$)/
const HEAVY_FILE_RE = /(^|[\\/])(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|uv\.lock)$|\.min\.(js|css)$/
const SENSITIVE_RE = /(^|[\\/])(\.env(\..*)?|id_rsa[^\\/]*|id_ed25519[^\\/]*|[^\\/]*\.(pem|key|p12|pfx)|[^\\/]*(credentials|secret)[^\\/]*)$/i
// Respostas MCP que não viram sandbox: as do próprio CATO e as de navegação/tela (imagens, estado de página)
const SKIP_MCP = /^mcp__(cato|claude[_-]browser|claude[_-]in[_-]chrome|computer[_-]use|playwright|puppeteer|chrome|browser|computer)__/i

// Configuração e estado da sessão. O estado recomeça a cada reload do módulo, sem prejuízo: no máximo um
// aviso se repete; o ledger de custo fica no $.store e sobrevive entre sessões.
let options: Options
let bands: number[] = []
let ttlMs = 60 * 60_000
let lastStepAt = 0
let lastModel = ''
let lastCtx = 0
let compactedAt = 0
let pendingContext: string | null = null
let python: string | null | undefined
const acks = new Set<string>()

const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

const emptyDay = (): Day => ({
  calls: 0, cost: 0, read: 0, write: 0, output: 0, ctxSum: 0, maxCtx: 0, missIdle: 0, missIdleCost: 0,
  missModel: 0, missModelCost: 0, missOther: 0, missOtherCost: 0, compressions: 0, compressedTokens: 0,
  blockedReads: 0, guardHolds: 0,
})

const writePrice = (model: string): number =>
  options.cacheTtlMinutes >= 60 ? priceFor(model).write1h : priceFor(model).write5m

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
}

async function loadLedger($: EngineInterface): Promise<Ledger> {
  const raw = await $.store.get(LEDGER_KEY)
  return raw && typeof raw === 'object' && 'days' in raw ? (raw as Ledger) : { days: {} }
}

async function bumpDay($: EngineInterface, change: (day: Day) => void): Promise<void> {
  const ledger = await loadLedger($)
  const key = dayKey(await $.clock.now())
  const day = { ...emptyDay(), ...(ledger.days[key] ?? {}) }
  change(day)
  ledger.days[key] = day
  const keys = Object.keys(ledger.days).sort()
  for (const old of keys.slice(0, Math.max(0, keys.length - LEDGER_DAYS))) delete ledger.days[old]
  await $.store.set(LEDGER_KEY, ledger)
}

async function homeDir($: EngineInterface): Promise<string> {
  return ((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.').replace(/\\/g, '/')
}

async function git($: EngineInterface, args: string[]): Promise<string> {
  try {
    const r = await $.process.run(['git', ...args], { timeoutMs: 3000 })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

// -------------------------------------------------------------------------------------------------------
// Status: contexto, custo do próximo turno e quanto falta para o cache expirar (convive com a statusLine)
// -------------------------------------------------------------------------------------------------------
async function refreshStatus($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const ctx = usage.context.tokens ?? lastCtx
  if (!ctx) return $.ui.status(undefined)
  const model = lastModel || (await $.session.model())
  const parts = [`CATO ctx ${Math.round(ctx / 1000)}k`]
  if (compactedAt > lastStepAt) {
    parts.push('compactado')
  } else if (lastStepAt) {
    const idle = (await $.clock.now()) - lastStepAt
    if (idle > ttlMs) {
      parts.push(`cache expirado: próximo turno ≈ ${usd((ctx * writePrice(model)) / 1e6)}`)
    } else {
      parts.push(`próximo turno ≈ ${usd((ctx * priceFor(model).read) / 1e6, 3)}`, `cache expira em ${Math.ceil((ttlMs - idle) / 60_000)}min`)
    }
  }
  if (usage.cost) parts.push(`sessão ${usd(usage.cost.usd)}`)
  $.ui.status(parts.join(' · '))
}

// -------------------------------------------------------------------------------------------------------
// Checagem de sintaxe logo após editar: JSON sempre; Python só se houver Python na máquina
// -------------------------------------------------------------------------------------------------------
async function findPython($: EngineInterface): Promise<string | null> {
  if (python !== undefined) return python
  for (const candidate of ['python3', 'python', 'py']) {
    try {
      const r = await $.process.run([candidate, '-c', 'print(1)'], { timeoutMs: 5000 })
      if (r.exitCode === 0 && r.stdout.trim() === '1') return (python = candidate)
    } catch {
      // tenta o próximo
    }
  }
  return (python = null)
}

async function syntaxProblem($: EngineInterface, path: string): Promise<string | null> {
  const lower = path.toLowerCase()
  if (lower.endsWith('.json')) {
    try {
      JSON.parse((await $.fs.read(path)) as string)
      return null
    } catch (error) {
      return `[CATO] O JSON ${path} ficou inválido: ${(error as Error).message}. Corrija com Edit.`
    }
  }
  if (lower.endsWith('.py') && options.pythonChecks) {
    const py = await findPython($)
    if (!py) return null
    const r = await $.process.run([py, '-m', 'py_compile', path], { timeoutMs: 10_000 })
    if (r.exitCode === 0) return null
    const detail = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')
    return `[CATO] A edição em ${path} introduziu um erro de sintaxe: ${detail}. Corrija com Edit sem precisar rodar Bash.`
  }
  return null
}

// -------------------------------------------------------------------------------------------------------
// Ferramentas do CATO para o modelo
// -------------------------------------------------------------------------------------------------------
async function readableProjectFile($: EngineInterface, path: string): Promise<string> {
  const root = (await $.session.cwd()).replace(/\\/g, '/').replace(/\/$/, '')
  const normalized = path.replace(/\\/g, '/')
  const absolute = /^([A-Za-z]:)?\//.test(normalized) ? normalized : `${root}/${normalized}`
  if (absolute.split('/').includes('..') || !absolute.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    throw new Error(`${path} está fora do projeto (${root}).`)
  }
  if (SENSITIVE_RE.test(absolute)) throw new Error(`${path} parece conter segredos e não é lido pelo CATO.`)
  const { decision } = await $.tool.check({ tool: 'Read', input: { file_path: absolute } })
  if (decision === 'deny') throw new Error(`${path} é bloqueado pelas suas regras de permissão de leitura.`)
  return absolute
}

async function listCodeFiles($: EngineInterface, limit: number): Promise<string[]> {
  const listed = await git($, ['ls-files', '--cached', '--others', '--exclude-standard'])
  if (listed) {
    return listed
      .split('\n')
      .filter(p => p && isCodeFile(p) && !p.split('/').some(part => IGNORED_DIRS.has(part)))
      .sort()
      .slice(0, limit)
  }
  const found: string[] = []
  const pending = ['']
  while (pending.length && found.length < limit) {
    const dir = pending.shift()!
    for (const entry of await $.fs.list(dir || undefined)) {
      const path = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.kind === 'dir' && !IGNORED_DIRS.has(entry.name)) pending.push(path)
      else if (entry.kind === 'file' && isCodeFile(entry.name) && found.length < limit) found.push(path)
    }
  }
  return found
}

async function repoMap($: EngineInterface, focus: string | undefined, budget: number): Promise<string> {
  const files = new Map<string, string>()
  for (const path of await listCodeFiles($, 300)) {
    try {
      if ((await $.fs.stat(path)).size > 200_000) continue
      files.set(path, (await $.fs.read(path)) as string)
    } catch {
      // arquivo sumiu ou é ilegível: segue
    }
  }
  return buildRepoMap(files, focus, budget)
}

async function readSymbol($: EngineInterface, filePath: string, symbol: string): Promise<string> {
  const path = await readableProjectFile($, filePath)
  const found = extractSymbol(path, (await $.fs.read(path)) as string, symbol)
  if (!found) return `Símbolo '${symbol}' não encontrado em ${filePath}.`
  return `# [CATO Symbol Extract: ${symbol} em ${filePath} (L${found.start}-L${found.end})]\n${found.text}`
}

async function searchSandbox($: EngineInterface, id: string, query: string): Promise<string> {
  const home = await homeDir($)
  const chunks: SandboxChunk[] = id.startsWith('sbx_')
    ? (JSON.parse((await $.fs.read(`${home}/.cato/sandbox/${id}.json`)) as string) as { chunks: SandboxChunk[] }).chunks
    : chunkLines((await $.fs.read(`${home}/.cato/logs/${id}.log`)) as string)
  const hits = bm25Search(chunks, query)
  return hits.length ? hits.map(h => `=== [${h.title}] ===\n${h.content}`).join('\n\n') : `Nenhum resultado para '${query}' em ${id}.`
}

async function costReport($: EngineInterface, days: number): Promise<string> {
  const ledger = await loadLedger($)
  const now = await $.clock.now()
  const sum = (n: number): Day => {
    const total = emptyDay()
    for (let i = 0; i < n; i++) {
      const d = ledger.days[dayKey(now - i * 86_400_000)]
      if (!d) continue
      for (const k of Object.keys(total) as (keyof Day)[]) {
        total[k] = k === 'maxCtx' ? Math.max(total[k], d[k] ?? 0) : total[k] + (d[k] ?? 0)
      }
    }
    return total
  }
  const line = (label: string, d: Day) =>
    `  ${label.padEnd(9)} ${usd(d.cost).padStart(10)}  ${String(d.calls).padStart(6)} chamadas  ` +
    `contexto médio ${d.calls ? Math.round(d.ctxSum / d.calls / 1000) : 0}k  máx ${Math.round(d.maxCtx / 1000)}k`
  const period = sum(days)
  const out = [
    'CATO — custo real registrado (preço oficial × tokens faturados de cada chamada)',
    line('hoje', sum(1)),
    line('7 dias', sum(7)),
    line(`${days} dias`, period),
    '',
    `Cache misses (${days} dias, reescrita > 100k tokens numa chamada):`,
    `  pausa maior que o cache   ${period.missIdle}x  ${usd(period.missIdleCost)}`,
    `  troca de modelo           ${period.missModel}x  ${usd(period.missModelCost)}`,
    `  outras (prefixo mudou)    ${period.missOther}x  ${usd(period.missOtherCost)}`,
    '',
    `Intervenções: ${period.guardHolds} prompts segurados, ${period.blockedReads} leituras pesadas negadas, ` +
      `${period.compressions} saídas comprimidas (−${period.compressedTokens.toLocaleString('pt-BR')} tokens).`,
  ]
  const recs: string[] = []
  if (period.cost > 0 && period.missIdleCost / period.cost > 0.03) recs.push('Ao voltar de uma pausa longa, use /clear ou /compact em vez de continuar com contexto grande.')
  if (period.cost > 0 && period.missModelCost / period.cost > 0.02) recs.push('Evite trocar de modelo no meio da sessão; use um subagente com outro modelo.')
  if (period.calls && period.ctxSum / period.calls > 300_000) recs.push('O contexto médio passa de 300k: use /clear entre tarefas e /compact quando o CATO avisar.')
  if (period.cost > 0 && (period.output * priceFor(lastModel).output) / 1e6 / period.cost > 0.1) recs.push('Output passa de 10% do custo: effortLevel alto gera muito raciocínio; use high/medium em tarefas rotineiras.')
  if (recs.length) out.push('', 'O que mais economiza no seu uso:', ...recs.map(r => `  • ${r}`))
  if (!period.calls) out.push('', 'Ainda não há chamadas registradas: o CATO registra o custo a partir da instalação.')
  return out.join('\n')
}

// Sandboxes e logs brutos com mais de 14 dias, uma vez por sessão. $.fs não apaga arquivos: usa o rm
// (Unix ou Git for Windows) e, sem ele, o del do cmd.
async function cleanupOldFiles($: EngineInterface): Promise<void> {
  try {
    const home = await homeDir($)
    const cutoff = (await $.clock.now()) - RAW_FILE_DAYS * 86_400_000
    for (const dir of [`${home}/.cato/sandbox`, `${home}/.cato/logs`]) {
      if (!(await $.fs.exists(dir))) continue
      const old = (await $.fs.list(dir))
        .filter(entry => entry.kind === 'file' && entry.mtimeMs < cutoff && /^(sbx|cmd)_[0-9a-f]{8}\.(json|log)$/.test(entry.name))
        .map(entry => `${dir}/${entry.name}`)
      for (let i = 0; i < old.length; i += 50) {
        const batch = old.slice(i, i + 50)
        const r = await $.process.run(['rm', '-f', ...batch], { timeoutMs: 5000 }).catch(() => null)
        if (!r || r.exitCode !== 0) {
          await $.process.run(['cmd', '/c', 'del', '/q', ...batch.map(p => p.replace(/\//g, '\\'))], { timeoutMs: 5000 }).catch(() => null)
        }
      }
    }
  } catch {
    // limpeza é melhor esforço
  }
}

export const register: Register = (on, rawOptions) => {
  options = rawOptions as unknown as Options
  bands = String(options.contextWarn ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)
  ttlMs = Math.max(1, Number(options.cacheTtlMinutes) || 60) * 60_000

  // ---------------------------------------------------------------------------------------------------
  // Registro de custo real por chamada de API (substitui o `cato report` daqui para frente)
  // ---------------------------------------------------------------------------------------------------
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (!usage || e.agentId) return result
    const now = await $.clock.now()
    const ctx = contextTokens(usage as StepUsage)
    const cost = usageCost(usage.model, usage as StepUsage, options.cacheTtlMinutes)
    const written = usage.cache_creation_input_tokens ?? 0
    const writeCost = (written * writePrice(usage.model)) / 1e6
    const cause =
      written <= MISS_THRESHOLD ? null
        : lastStepAt && now - lastStepAt > ttlMs ? 'idle'
          : lastModel && lastModel !== usage.model ? 'model'
            : 'other'
    await bumpDay($, day => {
      day.calls += 1
      day.cost += cost
      day.read += usage.cache_read_input_tokens ?? 0
      day.write += written
      day.output += usage.output_tokens
      day.ctxSum += ctx
      day.maxCtx = Math.max(day.maxCtx, ctx)
      if (cause === 'idle') { day.missIdle += 1; day.missIdleCost += writeCost }
      if (cause === 'model') { day.missModel += 1; day.missModelCost += writeCost }
      if (cause === 'other') { day.missOther += 1; day.missOtherCost += writeCost }
    })
    lastStepAt = now
    lastModel = usage.model
    lastCtx = ctx
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refreshStatus($)
    return result
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------------------------------------------
  // Guard de contexto e cache + autocompactação, antes de o prompt ir para a API
  // ---------------------------------------------------------------------------------------------------
  on('prompt.submit', async ($, e, next) => {
    const withPending = () => {
      if (!pendingContext) return e
      const extra = pendingContext
      pendingContext = null
      return { ...e, context: [...(e.context ?? []), extra] }
    }
    const typed = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!options.guard || e.command || e.isMeta || !typed || compactedAt > lastStepAt) return next(withPending())

    const usage = await $.session.usage()
    const ctx = usage.context.tokens ?? lastCtx
    const now = await $.clock.now()
    const model = lastModel || (await $.session.model())
    const price = priceFor(model)

    // Autocompactação (o que CLAUDE_AUTOCOMPACT_PCT_OVERRIDE fazia, agora sem variável de ambiente)
    const pct = usage.context.percent ?? 0
    if (options.autoCompactPercent > 0 && pct >= options.autoCompactPercent) {
      const compacted = await $.session.compact({}).then(r => !('skip' in r && r.skip)).catch(() => false)
      if (compacted) {
        $.ui.toast(`CATO: contexto em ${Math.round(pct)}% da janela; compactado antes do seu prompt.`)
        return next(withPending())
      }
    }

    // Cache expirado: o próximo turno reescreve o contexto inteiro
    if (lastStepAt && now - lastStepAt > ttlMs && ctx >= IDLE_MIN_CONTEXT) {
      const key = `idle:${lastStepAt}`
      if (!acks.has(key)) {
        acks.add(key)
        const rewrite = (ctx * writePrice(model)) / 1e6
        const compactCold = (ctx * price.write5m + COMPACT_SUMMARY_TOKENS * price.output) / 1e6
        const idleMin = Math.round((now - lastStepAt) / 60_000)
        const choices =
          `• /clear ≈ $0 — recomeça limpo (melhor se a próxima tarefa é outra)\n` +
          `• /compact ≈ ${usd(compactCold)} uma vez — o contexto cai para ~${COMPACT_SUMMARY_TOKENS / 1000}k`
        if (options.guardBlockUsd > 0 && rewrite >= options.guardBlockUsd) {
          await bumpDay($, day => { day.guardHolds += 1 })
          return {
            drop:
              `[CATO] Prompt segurado uma vez para evitar gasto: o cache desta conversa expirou (${idleMin} min parada) ` +
              `e continuar agora reescreve ${ctx.toLocaleString('pt-BR')} tokens ≈ ${usd(rewrite)}.\n${choices}\n` +
              `• Para continuar assim mesmo, envie o prompt de novo (não será segurado outra vez).`,
          }
        }
        $.ui.toast(`CATO: cache expirado (${idleMin} min); este turno reescreve ≈ ${usd(rewrite)}. /clear ou /compact saem mais barato.`)
      }
      return next(withPending())
    }

    // Contexto grande: só avisa, uma vez por faixa
    const band = bands.filter(b => ctx >= b).pop()
    if (band && !acks.has(`ctx:${band}`)) {
      acks.add(`ctx:${band}`)
      $.ui.toast(
        `CATO: contexto em ${Math.round(ctx / 1000)}k tokens; cada turno relê tudo (≈ ${usd((ctx * price.read) / 1e6, 3)}/turno). ` +
          `/compact reduz para ~${COMPACT_SUMMARY_TOKENS / 1000}k; /clear se a próxima tarefa é outra.`,
      )
    }
    return next(withPending())
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------------------------------------------
  // Compactação: guarda o estado do Git antes e o devolve ao modelo no próximo prompt
  // ---------------------------------------------------------------------------------------------------
  on('session.compact', async ($, e, next) => {
    if (e.agentId) return next(e)
    const [branch, status, diffStat] = await Promise.all([
      git($, ['branch', '--show-current']),
      git($, ['status', '--short']),
      git($, ['diff', '--stat']),
    ])
    const result = await next(e)
    if (!('skip' in result && result.skip)) {
      compactedAt = await $.clock.now()
      for (const key of [...acks]) if (key.startsWith('ctx:')) acks.delete(key)
      if (branch || status) {
        pendingContext =
          `[CATO: estado do Git após a compactação — branch ${branch || 'desconhecida'}; não é preciso rodar git status de novo]\n` +
          `${status.slice(0, 800) || '(working tree limpa)'}\n${diffStat.slice(0, 800)}`.trim()
      }
      $.ui.status(undefined)
    }
    return result
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------------------------------------------
  // Leituras pesadas (node_modules, builds, lockfiles): negadas antes de encher o contexto
  // ---------------------------------------------------------------------------------------------------
  {
    on('tool.call', { tool: ['Read', 'Grep', 'Glob'] }, async ($, e, next) => {
      if (!options.blockHeavyReads) return next(e)
      const input = e as unknown as { file_path?: string; path?: string }
      const target = String(input.file_path ?? input.path ?? '')
      if (!target || !(HEAVY_DIR_RE.test(target) || HEAVY_FILE_RE.test(target))) return next(e)
      await bumpDay($, day => { day.blockedReads += 1 })
      return {
        deny:
          `[CATO] ${target} é dependência, build ou lockfile: ler isso só enche o contexto. ` +
          'Leia o código-fonte do projeto, ou peça explicitamente se precisar mesmo deste arquivo.',
      }
    }).catch(($, e, next) => next(e))
  }

  // ---------------------------------------------------------------------------------------------------
  // Saídas ruidosas do shell: comprime a saída real (o comando e as permissões ficam intactos)
  // ---------------------------------------------------------------------------------------------------
  {
    on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
      const command = String((e as unknown as { command?: string }).command ?? '')
      if (!options.compressShell || !isCompressibleCommand(command)) return next(e)
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError) return ran
      const result = ran.result as { stdout?: unknown; stderr?: string; interrupted?: boolean; isImage?: boolean } | undefined
      if (!result || typeof result.stdout !== 'string' || result.interrupted || result.isImage) return ran
      if (result.stderr && ERROR_SIGNAL_RE.test(result.stderr)) return ran
      const stdout = result.stdout
      const rawTokens = estimateTokens(stdout)
      if (rawTokens < 160 || stdout.length > 30_000) return ran // acima disso o Claude Code já entrega arquivo + prévia
      const { text, changed, strategy } = optimizeOutput(command, stdout)
      const optimized = estimateTokens(text)
      if (!changed || (rawTokens - optimized < 80 && optimized > rawTokens * 0.85)) return ran
      const id = `cmd_${randomId()}`
      const logPath = `${await homeDir($)}/.cato/logs/${id}.log`
      await $.fs.write(logPath, stdout)
      await bumpDay($, day => {
        day.compressions += 1
        day.compressedTokens += rawTokens - optimized
      })
      const footer = `\n[CATO #${id} (${strategy}): ${rawTokens} -> ${optimized} tokens (-${rawTokens - optimized} tok). Log bruto completo: ${logPath}]`
      return { ...ran, result: { ...result, stdout: text + footer } } as typeof ran
    }).catch(($, e, next) => (next.called ? Promise.reject(new Error('CATO: falha após rodar o comando')) : next(e)))
  }

  {
    on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
      const ran = await next(e)
      const path = String((e as unknown as { file_path?: string }).file_path ?? '')
      if (ran.deny !== undefined || ran.isError || !/\.(json|py)$/i.test(path)) return ran
      const problem = await syntaxProblem($, path).catch(() => null)
      return problem ? ({ ...ran, context: [...(ran.context ?? []), problem] } as typeof ran) : ran
    })
  }

  // ---------------------------------------------------------------------------------------------------
  // Forks copiam o contexto inteiro: pede um subagente com contexto limpo (o que CLAUDE_CODE_FORK_SUBAGENT=0 fazia)
  // ---------------------------------------------------------------------------------------------------
  on('agent.spawn', ($, e, next) =>
    options.disableForks && e.fork && !e.parentAgentId
      ? {
          deny:
            '[CATO] Fork desativado: ele copiaria o contexto inteiro desta conversa. ' +
            'Use um subagente comum (Explore, general-purpose ou cato-explorer) com um prompt objetivo.',
        }
      : next(e),
  ).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------------------------------------------
  // Respostas MCP grandes: viram um sandbox pesquisável e o modelo recebe só a prévia
  // ---------------------------------------------------------------------------------------------------
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!tool.startsWith('mcp__') || SKIP_MCP.test(tool)) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || typeof ran.text !== 'string') return ran
    if (/"type"\s*:\s*"(image|audio|resource)"/.test(JSON.stringify(ran.result ?? '').slice(0, 200_000))) return ran
    const rawTokens = estimateTokens(ran.text)
    if (rawTokens < 1500) return ran
    const id = `sbx_${randomId()}`
    const chunks = chunkLines(ran.text)
    const saved = await $.fs
      .write(`${await homeDir($)}/.cato/sandbox/${id}.json`, JSON.stringify({ tool, chunks }))
      .then(() => true)
      .catch(() => false)
    if (!saved) return ran
    const lines = ran.text.split('\n')
    const preview = lines.slice(0, 15).map(l => l.slice(0, 160)).join('\n').slice(0, 1200)
    const summary =
      `[CATO MCP Sandbox #${id} — ${rawTokens} tokens guardados em ${chunks.length} blocos]\n` +
      `A resposta de ${tool} (${lines.length} linhas) foi indexada para proteger o contexto.\n` +
      `Para buscar termos nela, chame a ferramenta mcp__cato__search_sandbox com id="${id}".\n\n` +
      `--- Prévia (primeiras 15 linhas) ---\n${preview}\n... [+${Math.max(0, lines.length - 15)} linhas em #${id}]`
    const result = ran.result as unknown
    const shaped = Array.isArray(result)
      ? [{ type: 'text', text: summary }]
      : result && typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)
        ? { ...(result as object), content: [{ type: 'text', text: summary }] }
        : summary
    return { ...ran, result: shaped, text: summary } as typeof ran
  })

  // ---------------------------------------------------------------------------------------------------
  // Ferramentas do CATO para o modelo e o comando /cato
  // ---------------------------------------------------------------------------------------------------
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'repo_map',
      description:
        'Mapa compacto do repositório: arquivos mais centrais (Personalized PageRank sobre quem usa os símbolos de quem), ' +
        'cada um com suas declarações e intervalos de linha [L<início>-L<fim>]. Use antes de explorar com várias rodadas de Glob/Grep/Read.',
      inputSchema: {
        type: 'object',
        properties: {
          focus: { type: 'string', description: 'Termos ou caminhos para priorizar no ranking' },
          token_budget: { type: 'number', description: 'Orçamento máximo em tokens (padrão 1200)' },
        },
      },
    })
    await $.tool.register({
      name: 'read_symbol',
      description:
        'Lê só a definição de uma classe, função ou método (`Classe`, `funcao` ou `Classe.metodo`) com números de linha, ' +
        'em vez do arquivo inteiro. Respeita as regras de permissão de leitura.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Caminho do arquivo, relativo ao projeto ou absoluto' },
          symbol: { type: 'string', description: 'Nome do símbolo' },
        },
        required: ['file_path', 'symbol'],
      },
    })
    await $.tool.register({
      name: 'search_sandbox',
      description: 'Busca termos (BM25) numa resposta MCP grande que o CATO guardou em sandbox (id sbx_xxxxxxxx) ou num log bruto de comando (cmd_xxxxxxxx).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'sbx_xxxxxxxx ou cmd_xxxxxxxx' },
          query: { type: 'string', description: 'Termos de busca' },
        },
        required: ['id', 'query'],
      },
    })
    await $.tool.register({
      name: 'cost_report',
      description: 'Custo real registrado pelo CATO (por chamada de API): hoje, 7 e 30 dias, contexto médio, cache misses por causa e recomendações.',
      inputSchema: { type: 'object', properties: { days: { type: 'number' } } },
    })
    await $.command.register({ name: 'cato', description: 'CATO: custo real, cache misses e o que mais economiza no seu uso', argumentHint: '[dias]' })
    await cleanupOldFiles($)
    return next(e)
  }).catch(($, e, next) => next(e))

  const days = (value: unknown): number => Math.max(1, Math.min(LEDGER_DAYS, Number(value) || 30))

  on('command.run', { command: 'cato' }, async ($, e) => ({ text: await costReport($, days(String(e.args).trim())) }))

  on('tool.call', { tool: 'mcp__cato__cost_report' }, async ($, e) => ({
    result: await costReport($, days((e as unknown as { days?: number }).days)),
  }))

  on('tool.call', { tool: 'mcp__cato__repo_map' }, async ($, e) => {
    const input = e as unknown as { focus?: string; token_budget?: number }
    return { result: await repoMap($, input.focus, Number(input.token_budget) || 1200) }
  })

  on('tool.call', { tool: 'mcp__cato__read_symbol' }, async ($, e) => {
    const input = e as unknown as { file_path: string; symbol: string }
    try {
      return { result: await readSymbol($, String(input.file_path), String(input.symbol)) }
    } catch (error) {
      return { deny: `[CATO] ${(error as Error).message}` }
    }
  })

  on('tool.call', { tool: 'mcp__cato__search_sandbox' }, async ($, e) => {
    const input = e as unknown as { id: string; query: string }
    const id = String(input.id).replace(/^#/, '')
    if (!/^(sbx|cmd)_[0-9a-f]{8}$/.test(id)) return { deny: `[CATO] ID inválido: ${id} (esperado sbx_xxxxxxxx ou cmd_xxxxxxxx).` }
    try {
      return { result: await searchSandbox($, id, String(input.query)) }
    } catch {
      return { deny: `[CATO] ${id} não encontrado (sandboxes e logs são apagados após ${RAW_FILE_DAYS} dias).` }
    }
  })
}
