// CATO como mod do Claude Code: tudo roda dentro do Claude Code, sem Python e sem processo por hook.
//
// O que pesa na fatura (medido em transcripts reais): o contexto relido a cada turno e as reescritas de
// cache quando o TTL expira. Por isso o centro do CATO é o guard de contexto/cache, o status com o custo
// do próximo turno e a autocompactação; a compressão de saídas e o bloqueio de leituras pesadas vêm junto.

import type { EngineInterface, Register } from 'claude-code'

import { bm25Search, buildRepoMap, chunkLines, extractSymbol, IGNORED_DIRS, isCodeFile, skeleton } from './lib/codeintel.ts'
import type { SandboxChunk } from './lib/codeintel.ts'
import { AST_GREP_JSON_RE, ERROR_SIGNAL_RE, estimateTokens, isCompressibleCommand, optimizeOutput } from './lib/compress.ts'
import {
  compactGithubText,
  formatAstGrepMatches,
  graphFileEdges,
  GRAPHIFY_JSON,
  GRAPHIFY_REPORT,
  mcpTargetPath,
  parseGraph,
  queryGraph,
  SERENA_READ_TOOLS,
  SERENA_WRITE_TOOLS,
  serenaBudget,
  toolBaseName,
  toolFamily,
} from './lib/integrations.ts'
import type { Graph } from './lib/integrations.ts'
import { BAND_LABELS, contextBand, contextTokens, priceFor, sameModel, usageCost, usd } from './lib/pricing.ts'
import type { StepUsage } from './lib/pricing.ts'
import { addDay, dayKey, dayStart, emptyDay } from './lib/ledger.ts'
import type { Day, Ledger } from './lib/ledger.ts'
import { aggregate, AWK_EXTRACT, parseExtract, parseJsonlText, powershellExtract } from './lib/history.ts'
import type { TranscriptEvent } from './lib/history.ts'
import { maskOldToolResults } from './lib/compaction.ts'

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
  serenaMaxAnswerChars: number
  astGrepMaxResults: number
  compactGithub: boolean
  subagentCacheTtlMinutes: number
  compactInstructions: string
  readGuard: boolean
  maskColdCompact: boolean
}

// O que o resumo da compactação deve guardar: recall primeiro (guia de context engineering da Anthropic),
// e nada de saídas brutas, que só voltariam a encher o contexto
const CATO_COMPACT =
  'Mantenha o objetivo atual e os pedidos do usuário ainda abertos; as decisões tomadas e o motivo de cada uma; ' +
  'os caminhos dos arquivos alterados; erros e testes que ainda falham, com a mensagem exata; e os próximos passos. ' +
  'Não reproduza conteúdo de arquivos, saídas de ferramentas nem logs: cite caminhos e os IDs #cmd_/#sbx_ do CATO. Seja conciso.'

/** Instruções do CATO para a compactação; string vazia nas opções desliga. */
const compactInstructions = (): string =>
  typeof options.compactInstructions === 'string' ? options.compactInstructions.trim() : CATO_COMPACT

// Abaixo disso, trocar de modelo custa pouco e o aviso só atrapalharia
const MODEL_SWITCH_MIN_CONTEXT = 50_000


const LEDGER_KEY = 'ledger'
const HISTORY_KEY = 'history'
// $.fs.read e a saída de $.process.run param aqui
const FS_READ_LIMIT = 4 * 1024 * 1024
const MAX_SEEN_IDS = 200_000
// readGuard: a partir daqui um Read inteiro de código recebe antes o esqueleto (~15k tokens)
const READ_GUARD_BYTES = 60_000
// maskColdCompact: resultados de ferramenta fora das últimas trocas e acima disto viram uma linha
const MASK_KEEP_EXCHANGES = 10
const MASK_MIN_CHARS = 2_000
const MISS_THRESHOLD = 100_000
const IDLE_MIN_CONTEXT = 150_000
const COMPACT_SUMMARY_TOKENS = 15_000
const LEDGER_DAYS = 90
const RAW_FILE_DAYS = 14

// Leituras que só enchem o contexto (o equivalente às regras `deny` de Read que o CATO instalava)
const HEAVY_DIR_RE = /(^|[\\/])(node_modules|dist|build|coverage|\.next|target|\.venv|venv)([\\/]|$)/
const HEAVY_FILE_RE = /(^|[\\/])(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|uv\.lock)$|\.min\.(js|css)$/
// O grafo bruto e o cache do Graphify: o resumo está no GRAPH_REPORT.md e a consulta no graph_query
const GRAPHIFY_HEAVY_RE = /(^|[\\/])graphify-out[\\/](graph\.json|cache([\\/]|$))/
const SENSITIVE_RE = /(^|[\\/])(\.env(\..*)?|id_rsa[^\\/]*|id_ed25519[^\\/]*|[^\\/]*\.(pem|key|p12|pfx)|[^\\/]*(credentials|secret)[^\\/]*)$/i
// Respostas MCP que não viram sandbox: as do próprio CATO e as de navegação/tela (imagens, estado de página)
const SKIP_MCP = /^mcp__(cato|claude[_-]browser|claude[_-]in[_-]chrome|computer[_-]use|playwright|puppeteer|chrome|browser|computer)__/i

/** Por que ler este caminho só encheria o contexto, ou null se a leitura é normal. */
function heavyReason(path: string): string | null {
  if (GRAPHIFY_HEAVY_RE.test(path)) {
    return `[CATO] ${path} é o grafo bruto do Graphify. Leia ${GRAPHIFY_REPORT} para o panorama ou use mcp__cato__graph_query para um termo.`
  }
  if (HEAVY_DIR_RE.test(path) || HEAVY_FILE_RE.test(path)) {
    return `[CATO] ${path} é dependência, build ou lockfile: ler isso só enche o contexto. ` +
      'Leia o código-fonte do projeto, ou peça explicitamente se precisar mesmo deste arquivo.'
  }
  return null
}

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
let astGrep: string | null | undefined
let graphCache: { mtimeMs: number; graph: Graph | null } | null = null
const acks = new Set<string>()
// Estado de cache de cada subagente, separado do da conversa principal (o guard só olha a principal)
type AgentCacheState = { lastAt: number; lastModel: string; compactedAt: number }
const agentStates = new Map<string, AgentCacheState>()
const MAX_TRACKED_AGENTS = 50

const subagentTtlMinutes = (): number => Math.min(60, Math.max(1, Number(options.subagentCacheTtlMinutes) || 5))

function touchAgent(agentId: string, change: (state: AgentCacheState) => void): void {
  const state = agentStates.get(agentId) ?? { lastAt: 0, lastModel: '', compactedAt: 0 }
  change(state)
  agentStates.delete(agentId) // reinsere no fim: o Map fica em ordem de uso
  agentStates.set(agentId, state)
  for (const oldest of agentStates.keys()) {
    if (agentStates.size <= MAX_TRACKED_AGENTS) break
    agentStates.delete(oldest)
  }
}

/** Preço por milhão de tokens da escrita de cache no TTL dado, ou null para modelo sem preço conhecido. */
const writePrice = (model: string, ttlMinutes = options.cacheTtlMinutes): number | null => {
  const p = priceFor(model)
  return p ? (ttlMinutes >= 60 ? p.write1h : p.write5m) : null
}

/** Troca o texto de uma resposta MCP mantendo o formato que ela tinha (lista de blocos, `{ content }` ou texto). */
function withText<T extends { result?: unknown }>(ran: T, text: string): T {
  const result = ran.result
  const shaped = Array.isArray(result)
    ? [{ type: 'text', text }]
    : result && typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)
      ? { ...(result as object), content: [{ type: 'text', text }] }
      : text
  return { ...ran, result: shaped, text } as T
}

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
  const price = priceFor(model)
  const write = writePrice(model)
  const parts = [`CATO ctx ${Math.round(ctx / 1000)}k`]
  if (compactedAt > lastStepAt) {
    parts.push('compactado')
  } else if (lastStepAt) {
    const idle = (await $.clock.now()) - lastStepAt
    if (idle > ttlMs) {
      parts.push(write !== null ? `cache expirado: próximo turno ≈ ${usd((ctx * write) / 1e6)}` : 'cache expirado')
    } else {
      if (price) parts.push(`próximo turno ≈ ${usd((ctx * price.read) / 1e6, 3)}`)
      parts.push(`cache expira em ${Math.ceil((ttlMs - idle) / 60_000)}min`)
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

// Grafo do Graphify, relido só quando o arquivo muda; acima de 4 MiB o $.fs não lê e o CATO segue sem ele
async function loadGraph($: EngineInterface): Promise<Graph | null> {
  try {
    const { mtimeMs } = await $.fs.stat(GRAPHIFY_JSON)
    if (graphCache?.mtimeMs === mtimeMs) return graphCache.graph
    const graph = parseGraph((await $.fs.read(GRAPHIFY_JSON)) as string, await $.session.cwd())
    graphCache = { mtimeMs, graph }
    return graph
  } catch {
    return null
  }
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
  const graph = await loadGraph($)
  const map = buildRepoMap(files, focus, budget, graph ? graphFileEdges(graph) : undefined)
  return graph ? `${map}\n\n[Ranking reforçado pelo grafo do Graphify: ${graph.links.length} relações. Panorama em ${GRAPHIFY_REPORT}.]` : map
}

async function graphQuery($: EngineInterface, term: string, limit: number): Promise<string> {
  const graph = await loadGraph($)
  if (graph) return queryGraph(graph, term, limit)
  const exists = await $.fs.exists(GRAPHIFY_JSON).catch(() => false)
  return exists
    ? `${GRAPHIFY_JSON} existe mas não pôde ser lido (inválido ou acima de 4 MiB). Use o MCP do Graphify ou ${GRAPHIFY_REPORT}.`
    : 'Este projeto não tem grafo do Graphify (graphify-out/graph.json). Gere com /graphify . ou use mcp__cato__repo_map.'
}

// ast-grep: `ast-grep` e, no Windows/macOS, o atalho `sg` (no Linux `sg` costuma ser o setgroups, por isso a checagem)
async function findAstGrep($: EngineInterface): Promise<string | null> {
  if (astGrep !== undefined) return astGrep
  for (const candidate of ['ast-grep', 'sg']) {
    try {
      const r = await $.process.run([candidate, '--version'], { timeoutMs: 5000 })
      if (r.exitCode === 0 && /ast-grep/i.test(r.stdout + r.stderr)) return (astGrep = candidate)
    } catch {
      // tenta o próximo
    }
  }
  return (astGrep = null)
}

async function structuralSearch($: EngineInterface, input: { pattern: string; lang?: string; path?: string; max_results?: number }): Promise<string> {
  const bin = await findAstGrep($)
  if (!bin) return 'ast-grep não está instalado (npm i -g @ast-grep/cli, cargo install ast-grep, brew install ast-grep). Use Grep enquanto isso.'
  const root = (await $.session.cwd()).replace(/\\/g, '/').replace(/\/$/, '')
  const target = String(input.path || '.').replace(/\\/g, '/')
  const absolute = /^([A-Za-z]:)?\//.test(target) ? target : `${root}/${target}`
  if (absolute.split('/').includes('..') || !(`${absolute}/`.toLowerCase().startsWith(`${root.toLowerCase()}/`))) {
    throw new Error(`${target} está fora do projeto (${root}).`)
  }
  if (SENSITIVE_RE.test(absolute)) throw new Error(`${target} parece conter segredos e não é lido pelo CATO.`)
  const reason = heavyReason(target)
  if (reason) throw new Error(reason.replace('[CATO] ', ''))
  const args = [bin, 'run', '--pattern', input.pattern, '--json=stream', ...(input.lang ? ['--lang', input.lang] : []), target]
  const r = await $.process.run(args, { timeoutMs: 30_000 })
  if (r.exitCode !== 0 && !r.stdout.trim()) return `ast-grep falhou: ${(r.stderr || 'sem saída').trim().slice(0, 600)}`
  const max = Number(input.max_results) || options.astGrepMaxResults || 60
  return formatAstGrepMatches(r.stdout, max) ?? r.stdout.slice(0, 20_000)
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
  const history = await loadHistory($)
  const now = await $.clock.now()
  // O histórico importado só tem dias anteriores ao ledger ao vivo (liveSince), então somar não conta duas vezes
  const sum = (n: number): Day => {
    const total = emptyDay()
    for (const key of lastDayKeys(now, n)) {
      addDay(total, ledger.days[key])
      addDay(total, history?.days[key])
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
    ...(days === 1 || days === 7 ? [] : [line(`${days} dias`, period)]),
    ...(period.subCalls
      ? [
          `  subagentes (${days} dias): ${usd(period.subCost)} em ${period.subCalls} chamadas — ` +
            `${Math.round((period.subCost / Math.max(period.cost + period.subCost, 1e-9)) * 100)}% do total ` +
            `(as linhas acima são só a conversa principal)`,
        ]
      : []),
    '',
    `Cache misses da conversa principal (${days} dias, reescrita > 100k tokens numa chamada):`,
    `  pausa maior que o cache   ${period.missIdle}x  ${usd(period.missIdleCost)}`,
    `  troca de modelo           ${period.missModel}x  ${usd(period.missModelCost)}`,
    `  outras (prefixo mudou)    ${period.missOther}x  ${usd(period.missOtherCost)}`,
    `Reconstruções esperadas após compactar (não são misses): ${period.rebuilds}x  ${usd(period.rebuildCost)}`,
    ...(period.subMisses ? [`Cache misses de subagentes: ${period.subMisses}x  ${usd(period.subMissCost)}`] : []),
    ...(period.unpriced ? [`${period.unpriced} chamadas de modelo sem preço conhecido ficaram fora do custo.`] : []),
    ...(period.cost > 0
      ? [
          '',
          `Custo da conversa principal por tamanho de contexto (${days} dias):`,
          '  ' + BAND_LABELS.map((label, i) => {
            const cost = period[`band${i as 0 | 1 | 2 | 3}`]
            return `${label}: ${usd(cost)} (${Math.round((cost / period.cost) * 100)}%)`
          }).join('  |  '),
        ]
      : []),
    '',
    `Intervenções: ${period.guardHolds} prompts segurados, ${period.blockedReads} leituras pesadas negadas, ` +
      `${period.compressions} saídas comprimidas (≈ −${period.compressedTokens.toLocaleString('pt-BR')} tokens, estimativa por caracteres).`,
    ...(period.readGuardDenies
      ? [`Esqueleto em leitura grande: ${period.readGuardDenies} leituras desviadas, ${period.readGuardBypass} liberadas na segunda tentativa.`]
      : []),
  ]
  const recs: string[] = []
  if (period.cost > 0 && period.missIdleCost / period.cost > 0.03) recs.push('Ao voltar de uma pausa longa, use /clear ou /compact em vez de continuar com contexto grande.')
  if (period.cost > 0 && period.missModelCost / period.cost > 0.02) recs.push('Evite trocar de modelo no meio da sessão; use um subagente com outro modelo.')
  if (period.calls && period.ctxSum / period.calls > 300_000) recs.push('O contexto médio passa de 300k: use /clear entre tarefas e /compact quando o CATO avisar.')
  const outputPrice = priceFor(lastModel)?.output
  if (period.cost > 0 && outputPrice && (period.output * outputPrice) / 1e6 / period.cost > 0.1) recs.push('Output passa de 10% do custo: effortLevel alto gera muito raciocínio; use high/medium em tarefas rotineiras.')
  if (period.subCost > 0 && period.subCost / (period.cost + period.subCost) > 0.3) {
    recs.push('Subagentes passam de 30% do custo: dê `model: haiku` ou `sonnet` aos de tarefas simples (busca, leitura, testes).')
  }
  if (period.readGuardDenies >= 5 && period.readGuardBypass / period.readGuardDenies > 0.3) {
    recs.push('Mais de 30% das leituras desviadas pelo readGuard foram pedidas de novo: ele está custando turnos; considere desligá-lo.')
  }
  if (period.cost > 0 && period.band3 / period.cost > 0.3) {
    recs.push('Mais de 30% do custo vem de turnos com contexto acima de 400k: /clear entre tarefas e /compact nas pausas naturais.')
  }
  if (recs.length) out.push('', 'O que mais economiza no seu uso:', ...recs.map(r => `  • ${r}`))
  if (history?.calls) {
    out.push('', `Inclui ${history.calls} chamadas importadas dos transcripts (${dayKey(history.first)} a ${dayKey(history.last)}).`)
  } else {
    out.push('', 'Para incluir as sessões anteriores à instalação: /cato importar')
  }
  if (!period.calls && !period.subCalls) out.push('Ainda não há chamadas registradas no período.')
  return out.join('\n')
}

// -------------------------------------------------------------------------------------------------------
// Import do histórico (/cato importar): transcripts anteriores à instalação, sem contar nada duas vezes
// -------------------------------------------------------------------------------------------------------
type ImportedFile = { size: number; mtimeMs: number; status: 'done' | 'skipped' | 'failed'; calls: number; note?: string }

type History = {
  // Só entra o que veio antes disto: dali em diante o ledger ao vivo já contou
  liveSince: number
  days: Record<string, Day>
  files: Record<string, ImportedFile>
  // Hashes dos ids já importados (sessões retomadas repetem chamadas em outro arquivo)
  seen: string[]
  calls: number
  first: number
  last: number
  // Arquivo em processamento; se ficar marcado, a execução anterior parou no meio dele
  pending?: { path: string; size: number; mtimeMs: number }
}

async function loadHistory($: EngineInterface): Promise<History | null> {
  const raw = await $.store.get(HISTORY_KEY)
  return raw && typeof raw === 'object' && 'liveSince' in raw ? (raw as History) : null
}

/** Chaves dos últimos `n` dias (hoje incluso), andando pelo calendário local. */
function lastDayKeys(now: number, n: number): string[] {
  const d = new Date(now)
  return Array.from({ length: n }, (_, i) => dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i, 12).getTime()))
}

async function claudeConfigDir($: EngineInterface): Promise<string> {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  return (custom || `${await homeDir($)}/.claude`).replace(/\\/g, '/').replace(/\/$/, '')
}

type TranscriptFile = { path: string; size: number; mtimeMs: number; isSub: boolean }

async function listTranscripts($: EngineInterface): Promise<TranscriptFile[]> {
  const projects = `${await claudeConfigDir($)}/projects`
  if (!(await $.fs.exists(projects).catch(() => false))) return []
  const found: TranscriptFile[] = []
  for (const project of await $.fs.list(projects)) {
    if (project.kind !== 'dir') continue
    const dir = `${projects}/${project.name}`
    for (const entry of await $.fs.list(dir).catch(() => [])) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) {
        found.push({ path: `${dir}/${entry.name}`, size: entry.size, mtimeMs: entry.mtimeMs, isSub: false })
      } else if (entry.kind === 'dir') {
        const subDir = `${dir}/${entry.name}/subagents`
        for (const sub of await $.fs.list(subDir).catch(() => [])) {
          if (sub.kind === 'file' && sub.name.endsWith('.jsonl')) {
            found.push({ path: `${subDir}/${sub.name}`, size: sub.size, mtimeMs: sub.mtimeMs, isSub: true })
          }
        }
      }
    }
  }
  return found
}

type Extractor = 'awk' | 'powershell' | null

async function findExtractor($: EngineInterface): Promise<Extractor> {
  const probes: [Extractor, string[]][] = [
    ['awk', ['awk', 'BEGIN { print "ok" }']],
    ['powershell', ['powershell', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output ok']],
  ]
  for (const [name, argv] of probes) {
    const r = await $.process.run(argv, { timeoutMs: 15_000 }).catch(() => null)
    if (r && r.exitCode === 0 && r.stdout.trim() === 'ok') return name
  }
  return null
}

async function readTranscript($: EngineInterface, file: TranscriptFile, extractor: Extractor): Promise<TranscriptEvent[] | string> {
  if (extractor) {
    const argv = extractor === 'awk'
      ? ['awk', AWK_EXTRACT, file.path]
      : ['powershell', '-NoProfile', '-NonInteractive', '-Command', powershellExtract(file.path)]
    const r = await $.process.run(argv, { timeoutMs: 180_000 }).catch((error: Error) => error)
    if (r instanceof Error) return `extrator falhou: ${r.message.slice(0, 120)}`
    if (r.exitCode !== 0) return `extrator saiu com código ${r.exitCode}`
    if (r.isStdoutTruncated) return 'extrato passou de 4 MiB'
    return parseExtract(r.stdout)
  }
  if (file.size > FS_READ_LIMIT) return 'acima de 4 MiB e sem awk/PowerShell para extrair'
  return parseJsonlText((await $.fs.read(file.path)) as string)
}

async function importHistory($: EngineInterface, remainingMs: () => number): Promise<string> {
  const ledger = await loadLedger($)
  const now = await $.clock.now()
  const liveDays = Object.keys(ledger.days).sort()
  const history: History = (await loadHistory($)) ?? {
    liveSince: liveDays.length ? dayStart(liveDays[0]) : now,
    days: {}, files: {}, seen: [], calls: 0, first: 0, last: 0,
  }
  if (history.pending) {
    // A execução anterior parou no meio deste arquivo: não tenta de novo enquanto ele não mudar
    const { path, size, mtimeMs } = history.pending
    history.files[path] = { size, mtimeMs, status: 'failed', calls: history.files[path]?.calls ?? 0, note: 'interrompido no meio da leitura' }
    delete history.pending
  }

  const files = await listTranscripts($)
  // Arquivos novos ou que mudaram desde a última vez (os ids já vistos não contam de novo)
  const todo = files.filter(f => {
    const prev = history.files[f.path]
    return !prev || prev.size !== f.size || prev.mtimeMs !== f.mtimeMs
  })
  const extractor = todo.length ? await findExtractor($) : null
  const seen = new Set(history.seen)
  let processed = 0
  let added = 0
  for (const file of todo) {
    if (remainingMs() < 5_000) break
    history.pending = { path: file.path, size: file.size, mtimeMs: file.mtimeMs }
    await $.store.set(HISTORY_KEY, history)
    const events = await readTranscript($, file, extractor).catch((error: Error) => `falha ao ler: ${error.message.slice(0, 120)}`)
    if (typeof events === 'string') {
      history.files[file.path] = { size: file.size, mtimeMs: file.mtimeMs, status: file.size > FS_READ_LIMIT && !extractor ? 'skipped' : 'failed', calls: 0, note: events }
    } else {
      const result = aggregate(events, {
        mainTtlMinutes: options.cacheTtlMinutes >= 60 ? 60 : 5,
        subTtlMinutes: subagentTtlMinutes(),
        liveSince: history.liveSince,
        isSubFile: file.isSub,
      }, seen)
      for (const [key, day] of Object.entries(result.days)) history.days[key] = addDay(history.days[key] ?? emptyDay(), day)
      history.calls += result.calls
      if (result.calls) {
        history.first = history.first ? Math.min(history.first, result.first) : result.first
        history.last = Math.max(history.last, result.last)
      }
      history.files[file.path] = { size: file.size, mtimeMs: file.mtimeMs, status: 'done', calls: (history.files[file.path]?.calls ?? 0) + result.calls }
      added += result.calls
    }
    delete history.pending
    history.seen = [...seen].slice(-MAX_SEEN_IDS)
    await $.store.set(HISTORY_KEY, history)
    processed += 1
  }

  const statuses = Object.values(history.files)
  const failed = Object.entries(history.files).filter(([, f]) => f.status !== 'done')
  const remaining = todo.length - processed
  const out = [
    `CATO — import do histórico: ${processed} arquivos lidos agora, ${added} chamadas novas ` +
      `(total importado: ${history.calls} chamadas, ${statuses.filter(f => f.status === 'done').length} arquivos).`,
    `Extrator: ${extractor ?? 'nenhum (só arquivos até 4 MiB)'}. Só entram chamadas anteriores a ${dayKey(history.liveSince)}; dali em diante o CATO já registrava ao vivo.`,
  ]
  if (history.calls) out.push(`Período importado: ${dayKey(history.first)} a ${dayKey(history.last)}.`)
  if (remaining > 0) out.push(`Faltam ${remaining} arquivos (o tempo do comando acabou): rode /cato importar de novo para continuar.`)
  if (failed.length) {
    out.push(`${failed.length} arquivos ficaram de fora:`, ...failed.slice(0, 5).map(([path, f]) => `  • ${path.split('/').slice(-2).join('/')}: ${f.note ?? f.status}`))
  }
  out.push('Veja o resultado com /cato 30.')
  return out.join('\n')
}

// -------------------------------------------------------------------------------------------------------
// /cato doctor: diagnóstico só de leitura (integrações, conflitos, contexto fixo e cache)
// -------------------------------------------------------------------------------------------------------
type Json = Record<string, unknown>

async function readJson($: EngineInterface, path: string): Promise<Json | null> {
  try {
    const value = JSON.parse((await $.fs.read(path)) as string) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
  } catch {
    return null
  }
}

const objectKeys = (value: unknown): string[] => (value && typeof value === 'object' ? Object.keys(value as Json) : [])

async function commandWorks($: EngineInterface, argv: string[], pattern: RegExp): Promise<boolean> {
  const r = await $.process.run(argv, { timeoutMs: 5_000 }).catch(() => null)
  return !!r && r.exitCode === 0 && pattern.test(r.stdout + r.stderr)
}

async function folderSize($: EngineInterface, dir: string): Promise<{ files: number; bytes: number }> {
  const entries = await $.fs.list(dir).catch(() => [])
  return entries.filter(e => e.kind === 'file').reduce((acc, e) => ({ files: acc.files + 1, bytes: acc.bytes + e.size }), { files: 0, bytes: 0 })
}

/** TTL pedido ao Claude Code ('5m' | '1h') em minutos, ou null se não foi escolhido explicitamente. */
const ttlMinutes = (value: unknown): number | null => (value === '1h' ? 60 : value === '5m' ? 5 : null)

async function doctor($: EngineInterface): Promise<string> {
  const out: string[] = ['CATO — diagnóstico (só leitura: nada foi alterado)']
  const section = (title: string) => out.push('', title)
  const ok = (text: string) => out.push(`  ✅ ${text}`)
  const info = (text: string) => out.push(`  • ${text}`)
  const warn = (text: string) => out.push(`  ⚠ ${text}`)
  const bad = (text: string) => out.push(`  ❌ ${text}`)

  const home = await homeDir($)
  const cfg = await claudeConfigDir($)
  const cwd = (await $.session.cwd()).replace(/\\/g, '/').replace(/\/$/, '')
  // Ordem de precedência: usuário < projeto < local (o último que define vence)
  const settings = (await Promise.all([
    readJson($, `${cfg}/settings.json`),
    readJson($, `${cwd}/.claude/settings.json`),
    readJson($, `${cwd}/.claude/settings.local.json`),
  ])).filter((s): s is Json => !!s)
  const setting = (key: string): unknown => settings.reduce<unknown>((v, s) => (key in s ? s[key] : v), undefined)
  // Variável de ambiente: a do processo ou a do bloco "env" das settings ($.env.get só aceita nome literal)
  const envOr = (name: string, fromProcess: string | undefined): string => {
    if (fromProcess) return fromProcess
    const fromSettings = settings.reduce<unknown>((v, s) => ((s.env as Json | undefined)?.[name] ?? v), undefined)
    return typeof fromSettings === 'string' ? fromSettings : ''
  }
  const claudeJson = (await readJson($, `${cfg}/.claude.json`)) ?? (await readJson($, `${home}/.claude.json`))
  const projects = (claudeJson?.projects ?? {}) as Record<string, Json>
  const projectEntry = projects[cwd] ?? projects[cwd.replace(/\//g, '\\')] ?? null
  const mcpServers = [
    ...objectKeys(claudeJson?.mcpServers),
    ...objectKeys(projectEntry?.mcpServers),
    ...objectKeys((await readJson($, `${cwd}/.mcp.json`))?.mcpServers),
  ]
  const plugins = settings.flatMap(s => objectKeys(s.enabledPlugins))

  section('Conflitos')
  const legacyHooks = /\bcato\b/i.test(JSON.stringify(settings.map(s => s.hooks ?? {})))
  const legacyMcp = mcpServers.some(name => name.toLowerCase() === 'cato')
  if (legacyHooks || legacyMcp) {
    bad(
      `A versão Python do CATO ainda está configurada (${[legacyHooks && 'hooks no settings.json', legacyMcp && 'servidor MCP "cato"'].filter(Boolean).join(' e ')}): ` +
        'o CATO roda em dobro. Remova esses hooks e o servidor, ou restaure ~/.claude/settings.json.cato-backup.',
    )
  } else {
    ok('Sem resto da versão Python (hooks ou servidor MCP "cato").')
  }
  const autoCompactEnv = envOr('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'))
  if (autoCompactEnv && options.autoCompactPercent > 0) {
    warn(`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${autoCompactEnv} e autoCompactPercent=${options.autoCompactPercent} do CATO: use um só.`)
  }

  section('Integrações')
  ;(await commandWorks($, ['rtk', '--version'], /rtk/i)) ? ok('RTK instalado.') : info('RTK não encontrado (opcional).')
  ;(await findAstGrep($)) ? ok('ast-grep instalado: mcp__cato__structural_search ativo.') : info('ast-grep não encontrado (opcional): structural_search fica indisponível.')
  ;(await $.fs.exists(GRAPHIFY_JSON).catch(() => false)) ? ok('Grafo do Graphify neste projeto.') : info('Sem grafo do Graphify neste projeto (opcional).')
  mcpServers.some(n => /serena/i.test(n)) ? ok('Serena MCP configurado.') : info('Serena MCP não configurado (opcional).')
  mcpServers.some(n => /github/i.test(n)) || plugins.some(p => /github/i.test(p))
    ? ok('GitHub MCP configurado.')
    : info('GitHub MCP não configurado (opcional).')
  if (options.pythonChecks) (await findPython($)) ? ok('Python encontrado: checagem de sintaxe de .py ativa.') : info('Python não encontrado: só JSON é checado após edições.')

  section('Contexto fixo (entra em toda chamada)')
  for (const path of [`${cwd}/CLAUDE.md`, `${cwd}/.claude/CLAUDE.md`, `${cfg}/CLAUDE.md`]) {
    const text = await $.fs.read(path).catch(() => null)
    if (typeof text !== 'string') continue
    const lines = text.split('\n').length
    const label = path.startsWith(cfg) ? '~/.claude/CLAUDE.md' : path.slice(cwd.length + 1)
    lines > 200
      ? warn(`${label}: ${lines} linhas (a documentação recomenda menos de 200; instruções de fluxos específicos rendem mais como skills).`)
      : ok(`${label}: ${lines} linhas.`)
  }
  mcpServers.length > 10
    ? warn(`${mcpServers.length} servidores MCP configurados: desative em /mcp os que não usa (CLI como gh custa menos contexto).`)
    : info(`${mcpServers.length} servidores MCP configurados.`)
  if (envOr('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', await $.env.get('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'))) {
    warn('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS está definido: desliga o tool search (ferramentas MCP entram inteiras no contexto).')
  }

  section('Cache')
  const model = String(setting('model') ?? '')
  if (/opusplan/i.test(model)) warn('model=opusplan: cada entrada e saída do plan mode troca de modelo e relê a conversa sem cache.')
  const mainTtl = (envOr('FORCE_PROMPT_CACHING_5M', await $.env.get('FORCE_PROMPT_CACHING_5M'))) === '1' ? 5
    : ttlMinutes(envOr('CLAUDE_CODE_PROMPT_CACHE_TTL', await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'))) ?? ttlMinutes(setting('promptCacheTtl'))
  const catoMain = options.cacheTtlMinutes >= 60 ? 60 : 5
  if (mainTtl === null) info(`TTL da conversa principal no padrão do Claude Code (1h na assinatura, 5 min com chave de API); o CATO usa ${catoMain} min.`)
  else if (mainTtl !== catoMain) warn(`O Claude Code usa ${mainTtl} min de cache na conversa principal e o CATO calcula com ${catoMain}: ajuste cacheTtlMinutes.`)
  else ok(`TTL da conversa principal: ${mainTtl} min, igual ao do CATO.`)
  const subTtl = ttlMinutes(envOr('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'))) ?? ttlMinutes(setting('subagentPromptCacheTtl')) ?? 5
  const catoSub = subagentTtlMinutes() >= 60 ? 60 : 5
  subTtl !== catoSub
    ? warn(`Subagentes usam ${subTtl} min de cache no Claude Code e o CATO calcula com ${catoSub}: ajuste subagentCacheTtlMinutes.`)
    : ok(`TTL dos subagentes: ${subTtl} min, igual ao do CATO.`)
  info(`Compactação de conversas paradas (idleCompaction): ${setting('idleCompaction') === false ? 'desligada' : 'ligada (padrão)'}.`)

  section('Dados do CATO')
  for (const [label, dir] of [['sandboxes MCP', `${home}/.cato/sandbox`], ['logs brutos', `${home}/.cato/logs`]] as const) {
    const { files, bytes } = await folderSize($, dir)
    info(`${label}: ${files} arquivos, ${(bytes / 1e6).toFixed(1)} MB (apagados após ${RAW_FILE_DAYS} dias).`)
  }
  const history = await loadHistory($)
  info(history?.calls
    ? `Histórico importado: ${history.calls} chamadas (${dayKey(history.first)} a ${dayKey(history.last)}).`
    : 'Histórico ainda não importado: /cato importar.')

  section('Opções ativas')
  const flags = await experimentalFlags($)
  info(`Experimentais em vigor: readGuard ${onOff(flags.readGuard)}, maskColdCompact ${onOff(flags.maskColdCompact)} (/cato experimental).`)
  for (const [key, value] of Object.entries(options ?? {})) {
    const shown = typeof value === 'string' && value.length > 60 ? `${value.slice(0, 57)}...` : JSON.stringify(value)
    info(`${key} = ${shown}`)
  }
  return out.join('\n')
}

// -------------------------------------------------------------------------------------------------------
// /cato experimental [ligar|desligar|padrão]: liga os recursos experimentais sem passar pelo /plugin.
// As opções de plugin não são linhas do /config, então $.config.set não as alcança: a escolha fica no
// $.store do CATO e vale por cima da configuração do /plugin até "padrão" devolvê-la.
// -------------------------------------------------------------------------------------------------------
type ExperimentalOverride = { readGuard?: boolean; maskColdCompact?: boolean }

const EXPERIMENTAL_KEY = 'experimental'
let experimentalOverride: ExperimentalOverride | null = null

async function experimentalFlags($: EngineInterface): Promise<{ readGuard: boolean; maskColdCompact: boolean }> {
  if (!experimentalOverride) {
    const raw = await $.store.get(EXPERIMENTAL_KEY).catch(() => null)
    experimentalOverride = raw && typeof raw === 'object' ? (raw as ExperimentalOverride) : {}
  }
  return {
    readGuard: experimentalOverride.readGuard ?? !!options.readGuard,
    maskColdCompact: experimentalOverride.maskColdCompact ?? !!options.maskColdCompact,
  }
}

const EXPERIMENTAL_HELP =
  '  • readGuard: Read inteiro de código acima de 60 KB recebe antes o esqueleto com as linhas; a segunda tentativa passa.\n' +
  '  • maskColdCompact: com o cache expirado, resultados de ferramenta antigos e grandes viram uma linha antes do resumo.'

const onOff = (value: boolean): string => (value ? 'ligado' : 'desligado')

async function toggleExperimental($: EngineInterface, action: string): Promise<string> {
  const turnOn = ['ligar', 'on', 'ativar', 'sim'].includes(action)
  const turnOff = ['desligar', 'off', 'desativar', 'nao', 'não'].includes(action)
  const reset = ['padrão', 'padrao', 'reset'].includes(action)
  if (turnOn || turnOff || reset) {
    experimentalOverride = reset ? {} : { readGuard: turnOn, maskColdCompact: turnOn }
    await $.store.set(EXPERIMENTAL_KEY, experimentalOverride)
  }
  const flags = await experimentalFlags($)
  const source = Object.keys(experimentalOverride ?? {}).length ? 'escolhido por /cato experimental' : 'configuração do /plugin'
  const out = [`CATO — recursos experimentais (${source}): readGuard ${onOff(flags.readGuard)}, maskColdCompact ${onOff(flags.maskColdCompact)}.`]
  if (!turnOn && !turnOff && !reset) {
    out.push(EXPERIMENTAL_HELP, 'Use /cato experimental ligar, desligar, ou padrão para voltar a seguir o /plugin.')
  } else if (turnOn) {
    out.push(EXPERIMENTAL_HELP, 'O /cato mostra quantas leituras o readGuard desviou e quantas foram pedidas de novo.')
  }
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
    if (!usage) return result
    const now = await $.clock.now()

    // Subagente: soma no custo dele, com o TTL dele, sem tocar no estado de cache da conversa principal
    if (e.agentId) {
      const agentId = e.agentId
      const ttlMinutes = subagentTtlMinutes()
      const cost = usageCost(usage.model, usage as StepUsage, ttlMinutes)
      const written = usage.cache_creation_input_tokens ?? 0
      const state = agentStates.get(agentId)
      // A primeira chamada de um subagente sempre escreve o cache dele: só conta miss de quem já tinha cache
      const missed =
        written > MISS_THRESHOLD && !!state && state.lastAt > 0 && !(state.compactedAt > state.lastAt) &&
        (now - state.lastAt > ttlMinutes * 60_000 || state.lastModel !== usage.model)
      await bumpDay($, day => {
        day.subCalls += 1
        if (cost === null) day.unpriced += 1
        else day.subCost += cost
        if (missed) {
          day.subMisses += 1
          day.subMissCost += (written * (writePrice(usage.model, ttlMinutes) ?? 0)) / 1e6
        }
      })
      touchAgent(agentId, s => {
        s.lastAt = now
        s.lastModel = usage.model
      })
      return result
    }

    const ctx = contextTokens(usage as StepUsage)
    const cost = usageCost(usage.model, usage as StepUsage, options.cacheTtlMinutes)
    const written = usage.cache_creation_input_tokens ?? 0
    const writeCost = (written * (writePrice(usage.model) ?? 0)) / 1e6
    // A ordem importa: logo após compactar, a reescrita é esperada, mesmo que a pausa tenha passado do TTL
    const cause =
      written <= MISS_THRESHOLD ? null
        : compactedAt > lastStepAt ? 'rebuild'
          : lastStepAt && now - lastStepAt > ttlMs ? 'idle'
            : lastModel && lastModel !== usage.model ? 'model'
              : 'other'
    await bumpDay($, day => {
      day.calls += 1
      if (cost === null) day.unpriced += 1
      else day.cost += cost
      day.read += usage.cache_read_input_tokens ?? 0
      day.write += written
      day.output += usage.output_tokens ?? 0
      day.ctxSum += ctx
      day.maxCtx = Math.max(day.maxCtx, ctx)
      if (cost !== null) day[`band${contextBand(ctx)}`] += cost
      if (cause === 'rebuild') { day.rebuilds += 1; day.rebuildCost += writeCost }
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
      const instructions = compactInstructions()
      const compacted = await $.session
        .compact(instructions ? { instructions } : {})
        .then(r => !('skip' in r && r.skip))
        .catch(() => false)
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
        const idleMin = Math.round((now - lastStepAt) / 60_000)
        const write = writePrice(model)
        // Modelo sem preço conhecido: avisa em tokens e nunca segura o prompt por um custo que não sabe calcular
        if (!price || write === null) {
          $.ui.toast(`CATO: cache expirado (${idleMin} min); este turno reescreve ${Math.round(ctx / 1000)}k tokens. /clear ou /compact saem mais barato.`)
          return next(withPending())
        }
        const rewrite = (ctx * write) / 1e6
        const compactCold = (ctx * price.write5m + COMPACT_SUMMARY_TOKENS * price.output) / 1e6
        const choices =
          `• /clear ≈ $0 — recomeça limpo (melhor se a próxima tarefa é outra)\n` +
          `• /compact ≈ ${usd(compactCold)} uma vez — o contexto cai para ~${COMPACT_SUMMARY_TOKENS / 1000}k`
        if (options.guardBlockUsd > 0 && rewrite >= options.guardBlockUsd) {
          await bumpDay($, day => { day.guardHolds += 1 })
          return {
            drop:
              `[CATO] Prompt segurado uma vez para evitar gasto: o cache desta conversa expirou (${idleMin} min parada) ` +
              `e continuar agora reescreve ${ctx.toLocaleString('pt-BR')} tokens ≈ ${usd(rewrite)}.\n${choices}\n` +
              `• Para continuar assim mesmo, envie o prompt de novo (não será segurado outra vez).\n` +
              `Dica: com idleCompaction ligado (padrão), o Claude Code compacta sozinho conversas longas paradas no cache de 1h.`,
          }
        }
        $.ui.toast(`CATO: cache expirado (${idleMin} min); este turno reescreve ≈ ${usd(rewrite)}. /clear ou /compact saem mais barato.`)
      }
      return next(withPending())
    }

    // Troca de modelo com o cache quente: cada modelo tem o seu cache, então o próximo turno relê tudo.
    // O /model do terminal já pede confirmação; aqui só o custo, que vale também para o seletor do app,
    // o opusplan e skills com outro modelo. Nunca segura o prompt.
    if (lastModel && lastStepAt && now - lastStepAt <= ttlMs && ctx >= MODEL_SWITCH_MIN_CONTEXT) {
      const current = await $.session.model()
      const key = `model:${lastStepAt}:${current}`
      if (sameModel(current, lastModel) === false && !acks.has(key)) {
        acks.add(key)
        const write = writePrice(current)
        $.ui.toast(
          `CATO: trocar de ${lastModel} para ${current} relê ${Math.round(ctx / 1000)}k tokens sem cache` +
            `${write !== null ? ` ≈ ${usd((ctx * write) / 1e6)}` : ''}. ` +
            'Para uma tarefa pontual, um subagente com o outro modelo não mexe no cache desta conversa.',
        )
      }
    }

    // Contexto grande: só avisa, uma vez por faixa
    const band = bands.filter(b => ctx >= b).pop()
    if (band && !acks.has(`ctx:${band}`)) {
      acks.add(`ctx:${band}`)
      $.ui.toast(
        `CATO: contexto em ${Math.round(ctx / 1000)}k tokens; cada turno relê tudo${price ? ` (≈ ${usd((ctx * price.read) / 1e6, 3)}/turno)` : ''}. ` +
          `/compact reduz para ~${COMPACT_SUMMARY_TOKENS / 1000}k; /clear se a próxima tarefa é outra.`,
      )
    }
    return next(withPending())
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------------------------------------------
  // Compactação: devolve ao modelo o `git diff --stat` (branch e status o Claude Code já relê sozinho).
  // `precompute` só prepara um resumo para a próxima compactação: nada foi compactado ainda.
  // ---------------------------------------------------------------------------------------------------
  on('session.compact', async ($, e, next) => {
    // Instruções do CATO só quando ninguém deu as suas (o texto do /compact do usuário fica intocado).
    // Valem também para o precompute, cujo resumo é o que a próxima compactação instala.
    const instructions = compactInstructions()
    const call = !e.agentId && instructions && !e.instructions?.trim() ? { ...e, instructions } : e
    if (e.trigger === 'precompute') return next(call)
    if (e.agentId) {
      // Subagente compactado: a próxima escrita grande dele é reconstrução, não miss
      const agentId = e.agentId
      const done = await next(e)
      if (!('skip' in done && done.skip)) {
        const at = await $.clock.now()
        touchAgent(agentId, s => { s.compactedAt = at })
      }
      return done
    }
    const diffStat = await git($, ['diff', '--stat'])
    // Opcional: com o cache frio, resultados antigos e grandes viram uma linha antes do resumo (lê menos a preço cheio)
    let toSummarize = call
    if (lastStepAt && (await $.clock.now()) - lastStepAt > ttlMs && (await experimentalFlags($)).maskColdCompact) {
      const masked = maskOldToolResults(call.messages, MASK_KEEP_EXCHANGES, MASK_MIN_CHARS)
      if (masked.masked) toSummarize = { ...call, messages: masked.messages }
    }
    const result = await next(toSummarize)
    if (!('skip' in result && result.skip)) {
      compactedAt = await $.clock.now()
      for (const key of [...acks]) if (key.startsWith('ctx:')) acks.delete(key)
      if (diffStat) {
        pendingContext = `[CATO: alterações ainda não commitadas após a compactação (git diff --stat)]\n${diffStat.slice(0, 800)}`
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
      const reason = target ? heavyReason(target) : null
      if (!reason) return next(e)
      await bumpDay($, day => { day.blockedReads += 1 })
      return { deny: reason }
    }).catch(($, e, next) => next(e))
  }

  // ---------------------------------------------------------------------------------------------------
  // Opcional (readGuard): Read inteiro de arquivo de código grande recebe antes o esqueleto com as linhas
  // de cada declaração. A segunda tentativa no mesmo arquivo passa: o modelo nunca fica travado.
  // ---------------------------------------------------------------------------------------------------
  {
    on('tool.call', { tool: 'Read' }, async ($, e, next) => {
      if (!(await experimentalFlags($)).readGuard) return next(e)
      const input = e as unknown as { file_path?: string; offset?: number; limit?: number; pages?: string }
      const target = String(input.file_path ?? '')
      if (!target || input.offset !== undefined || input.limit !== undefined || input.pages !== undefined || !isCodeFile(target)) return next(e)
      // Fora do projeto, segredo ou negado pelas regras de leitura: o CATO não mostra nem o esqueleto
      const path = await readableProjectFile($, target).catch(() => null)
      if (!path) return next(e)
      const key = `readguard:${path.toLowerCase()}`
      if (acks.has(key)) {
        await bumpDay($, day => { day.readGuardBypass += 1 })
        return next(e)
      }
      const size = (await $.fs.stat(path).catch(() => null))?.size ?? 0
      if (size < READ_GUARD_BYTES || size > FS_READ_LIMIT) return next(e)
      const outline = skeleton(path, (await $.fs.read(path)) as string, 120)
      if (!outline) return next(e)
      acks.add(key)
      await bumpDay($, day => { day.readGuardDenies += 1 })
      return {
        deny:
          `[CATO] ${target} tem ${Math.round(size / 1000)} KB (≈${Math.round(size / 3.8 / 1000)}k tokens). Leia só o trecho que precisa ` +
          `com offset/limit usando as linhas abaixo, ou mcp__cato__read_symbol. Se precisar do arquivo inteiro, peça o Read de novo: ` +
          `a segunda tentativa passa.\n${outline}`,
      }
    }).catch(($, e, next) => (next.called ? Promise.reject(new Error('CATO: falha após o Read')) : next(e)))
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
      const astGrepText = AST_GREP_JSON_RE.test(command) ? formatAstGrepMatches(stdout, 0, 20_000) : null
      const { text, changed, strategy, omittedErrors } = astGrepText
        ? { text: astGrepText, changed: true, strategy: 'ast_grep_json', omittedErrors: 0 }
        : optimizeOutput(command, stdout)
      const optimized = estimateTokens(text)
      if (!changed || (rawTokens - optimized < 80 && optimized > rawTokens * 0.85)) return ran
      const id = `cmd_${randomId()}`
      const logPath = `${await homeDir($)}/.cato/logs/${id}.log`
      await $.fs.write(logPath, stdout)
      await bumpDay($, day => {
        day.compressions += 1
        day.compressedTokens += rawTokens - optimized
      })
      const warning = omittedErrors > 0
        ? `\n⚠ [CATO] ${omittedErrors} linhas de erro não mostradas acima. Busque no log com ` +
          `mcp__cato__search_sandbox id="${id}" query="error" (ou o termo da falha).`
        : ''
      const footer =
        `${warning}\n[CATO #${id} (${strategy}): ≈${rawTokens} -> ≈${optimized} tokens estimados (−${rawTokens - optimized}). ` +
        `Log bruto completo: ${logPath}]`
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
  // Respostas MCP: Serena e ast-grep recebem orçamento antes de rodar; GitHub sai sem campos de API;
  // o que continuar grande vira um sandbox pesquisável e o modelo recebe só a prévia
  // ---------------------------------------------------------------------------------------------------
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!tool.startsWith('mcp__') || SKIP_MCP.test(tool)) return next(e)
    const family = toolFamily(tool)
    const base = toolBaseName(tool)
    const input = e as unknown as Record<string, unknown>

    // Leituras pesadas pelas ferramentas de código e do GitHub, como no Read
    const target = family && family !== 'graphify' ? mcpTargetPath(input) : ''
    const reason = options.blockHeavyReads && target ? heavyReason(target) : null
    if (reason) {
      await bumpDay($, day => { day.blockedReads += 1 })
      return { deny: reason }
    }

    // Orçamento de resposta antes de a ferramenta rodar
    let call = e
    if (family === 'serena' && SERENA_READ_TOOLS.has(base)) {
      const budgeted = serenaBudget(input, options.serenaMaxAnswerChars)
      if (budgeted) call = budgeted as unknown as typeof e
    }
    if (family === 'astgrep' && /^find_code/.test(base) && options.astGrepMaxResults > 0 && !(Number(input.max_results) > 0)) {
      call = { ...input, max_results: options.astGrepMaxResults } as unknown as typeof e
    }

    const ran = await next(call)
    if (ran.deny !== undefined || ran.isError) return ran

    // Edição pela Serena: mesma checagem de sintaxe do Edit
    if (family === 'serena' && SERENA_WRITE_TOOLS.has(base) && /\.(json|py)$/i.test(target)) {
      const problem = await syntaxProblem($, target).catch(() => null)
      return problem ? ({ ...ran, context: [...(ran.context ?? []), problem] } as typeof ran) : ran
    }
    // Respostas da Serena e do ast-grep já vêm limitadas e localizadas (arquivo:linha): ficam inteiras
    if (family === 'serena' || family === 'astgrep' || typeof ran.text !== 'string') return ran
    if (/"type"\s*:\s*"(image|audio|resource)"/.test(JSON.stringify(ran.result ?? '').slice(0, 200_000))) return ran

    let text = ran.text
    let current = ran
    if (family === 'github' && options.compactGithub) {
      const compacted = compactGithubText(text)
      if (compacted.changed) {
        const saved = estimateTokens(text) - estimateTokens(compacted.text)
        await bumpDay($, day => {
          day.compressions += 1
          day.compressedTokens += Math.max(0, saved)
        })
        text = compacted.text
        current = withText(ran, text)
      }
    }

    const rawTokens = estimateTokens(text)
    if (rawTokens < 1500) return current
    const id = `sbx_${randomId()}`
    const chunks = chunkLines(text)
    const saved = await $.fs
      .write(`${await homeDir($)}/.cato/sandbox/${id}.json`, JSON.stringify({ tool, chunks }))
      .then(() => true)
      .catch(() => false)
    if (!saved) return current
    const lines = text.split('\n')
    const preview = lines.slice(0, 15).map(l => l.slice(0, 160)).join('\n').slice(0, 1200)
    const hint = family === 'github'
      ? '\nDica: no GitHub MCP, `fields`, `perPage`, `detail: "none"` (get_commit) e `tail_lines` (get_job_logs) reduzem a resposta.'
      : ''
    const summary =
      `[CATO MCP Sandbox #${id} — ≈${rawTokens} tokens (estimativa) guardados em ${chunks.length} blocos]\n` +
      `A resposta de ${tool} (${lines.length} linhas) foi indexada para proteger o contexto.\n` +
      `Para buscar termos nela, chame a ferramenta mcp__cato__search_sandbox com id="${id}".${hint}\n\n` +
      `--- Prévia (primeiras 15 linhas) ---\n${preview}\n... [+${Math.max(0, lines.length - 15)} linhas em #${id}]`
    return withText(ran, summary)
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
      name: 'structural_search',
      description:
        'Busca estrutural com ast-grep (casa pela árvore sintática, não por texto): ex. `console.log($A)`, `def $F($$$):`, ' +
        '`useEffect($$$)`. Devolve `arquivo:L<início>-L<fim>` e o trecho, compacto e limitado. Prefira ao Grep quando o padrão é de código.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Padrão ast-grep; $A casa um nó, $$$ casa vários' },
          lang: { type: 'string', description: 'Linguagem (ts, tsx, js, py, go, rs, java...); opcional se a extensão basta' },
          path: { type: 'string', description: 'Pasta ou arquivo dentro do projeto (padrão: o projeto todo)' },
          max_results: { type: 'number', description: 'Máximo de casamentos (padrão 60)' },
        },
        required: ['pattern'],
      },
    })
    await $.tool.register({
      name: 'graph_query',
      description:
        'Consulta o grafo de conhecimento do Graphify (graphify-out/graph.json) sem carregá-lo no contexto: nós que casam com o termo, ' +
        'onde estão (arquivo:linha), comunidade e relações com os vizinhos.',
      inputSchema: {
        type: 'object',
        properties: {
          term: { type: 'string', description: 'Nome de conceito, classe, função ou arquivo' },
          limit: { type: 'number', description: 'Máximo de nós (padrão 12)' },
        },
        required: ['term'],
      },
    })
    await $.tool.register({
      name: 'cost_report',
      description: 'Custo real registrado pelo CATO (por chamada de API): hoje, 7 e 30 dias, contexto médio, cache misses por causa e recomendações.',
      inputSchema: { type: 'object', properties: { days: { type: 'number' } } },
    })
    await $.command.register({
      name: 'cato',
      description:
        'CATO: custo real, cache misses e o que mais economiza no seu uso ' +
        '(importar: sessões anteriores; doctor: diagnóstico; experimental: liga/desliga os recursos experimentais)',
      argumentHint: '[dias | importar | doctor | experimental [ligar|desligar]]',
    })
    // O menu não mostra argumentos: cada subcomando também tem um comando próprio
    await $.command.register({ name: 'cato-doctor', description: 'CATO: diagnóstico do que gasta contexto nesta máquina (não altera nada)' })
    await $.command.register({ name: 'cato-importar', description: 'CATO: importa o custo das sessões anteriores à instalação' })
    await $.command.register({
      name: 'cato-experimental',
      description: 'CATO: mostra, liga ou desliga os recursos experimentais (readGuard e maskColdCompact)',
      argumentHint: '[ligar | desligar | padrão]',
    })
    await cleanupOldFiles($)
    return next(e)
  }).catch(($, e, next) => next(e))

  const days = (value: unknown): number => Math.max(1, Math.min(LEDGER_DAYS, Number(value) || 30))

  on('command.run', { command: 'cato' }, async ($, e, next) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'importar' || arg === 'import') {
      return { text: await importHistory($, () => next.budget.remainingMs) }
    }
    if (arg === 'doctor') return { text: await doctor($) }
    const experimental = arg.match(/^experimenta(?:l|is)(?:\s+(\S+))?$/)
    if (experimental) return { text: await toggleExperimental($, experimental[1] ?? '') }
    return { text: await costReport($, days(arg)) }
  })

  on('command.run', { command: 'cato-doctor' }, async $ => ({ text: await doctor($) }))
  on('command.run', { command: 'cato-importar' }, async ($, _e, next) => ({
    text: await importHistory($, () => next.budget.remainingMs),
  }))
  on('command.run', { command: 'cato-experimental' }, async ($, e) => ({
    text: await toggleExperimental($, String(e.args ?? '').trim().toLowerCase()),
  }))

  on('tool.call', { tool: 'mcp__cato__cost_report' }, async ($, e) => ({
    result: await costReport($, days((e as unknown as { days?: number }).days)),
  }))

  on('tool.call', { tool: 'mcp__cato__repo_map' }, async ($, e) => {
    const input = e as unknown as { focus?: string; token_budget?: number }
    return { result: await repoMap($, input.focus, Number(input.token_budget) || 1200) }
  })

  on('tool.call', { tool: 'mcp__cato__structural_search' }, async ($, e) => {
    const input = e as unknown as { pattern: string; lang?: string; path?: string; max_results?: number }
    if (!String(input.pattern ?? '').trim()) return { deny: '[CATO] Informe o padrão (pattern).' }
    try {
      return { result: await structuralSearch($, { ...input, pattern: String(input.pattern) }) }
    } catch (error) {
      return { deny: `[CATO] ${(error as Error).message}` }
    }
  })

  on('tool.call', { tool: 'mcp__cato__graph_query' }, async ($, e) => {
    const input = e as unknown as { term?: string; limit?: number }
    return { result: await graphQuery($, String(input.term ?? ''), Math.max(1, Math.min(50, Number(input.limit) || 12))) }
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
