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
import { BAND_LABELS, contextBand, contextTokens, priceFor, sameModel, usageCost } from './lib/pricing.ts'
import { bullet, formatter, heading, LANG_NAMES, langFrom, table, wrap } from './lib/format.ts'
import type { Fmt, Lang } from './lib/format.ts'
import { EXPERIMENTAL_WORDS, MESSAGES } from './lib/messages.ts'
import type { Messages } from './lib/messages.ts'
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
  language: string
  sandboxMinTokens: number
  sandboxSkip: string
  warmCache: boolean
}

// O que o resumo da compactação deve guardar: recall primeiro (guia de context engineering da Anthropic),
// e nada de saídas brutas, que só voltariam a encher o contexto. Em inglês: o modelo lê, e custa menos tokens.
const CATO_COMPACT =
  "Keep the current goal and the user's open requests; the decisions made and why; the paths of changed files; " +
  'errors and failing tests with the exact message; and the next steps. Do not reproduce file contents, tool output ' +
  "or logs: cite paths and CATO's #cmd_/#sbx_ IDs. Be concise and write the summary in the conversation's language."

/** Instruções do CATO para a compactação; string vazia nas opções desliga. */
const compactInstructions = (): string =>
  typeof options.compactInstructions === 'string' ? options.compactInstructions.trim() : CATO_COMPACT

// Explorador do CATO: Haiku, sem CLAUDE.md e só com ferramentas de leitura. Os passos citam apenas as
// ferramentas que esta máquina tem, para o agente não tentar uma que não foi registrada.
const EXPLORER_PROMPT = (hasGraph: boolean, hasAstGrep: boolean): string =>
  [
    "You are CATO's explorer. Find what was asked while spending as few tokens as possible, and return only the conclusion.",
    hasGraph
      ? '1. Read `graphify-out/GRAPH_REPORT.md` first and use `mcp__cato__graph_query` for the terms in the question; else start with `mcp__cato__repo_map` and `focus`.'
      : '1. Start with `mcp__cato__repo_map` and `focus`.',
    hasAstGrep
      ? '2. For code patterns (a call, a decorator, a signature), use `mcp__cato__structural_search` (ast-grep) instead of Grep.'
      : '2. Use Grep with a precise pattern and `glob`/`type` filters.',
    '3. To read a function or class, use `mcp__cato__read_symbol`; for large files, `Read` with `offset`/`limit` on the `[L<start>-L<end>]` ranges.',
    '4. Do not read dependencies, build output, lockfiles, `graphify-out/graph.json` or secret files (`.env`, keys).',
    '5. Answer with paths and lines (`file:line`) and a short summary, in the language the question was asked in. Do not paste whole files.',
  ].join('\n')

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
// O Read do Claude Code recusa mais que isto sem offset/limit: a economia de uma leitura evitada não passa daqui
const READ_MAX_TOKENS = 25_000
const readTokens = (bytes: number): number => Math.min(READ_MAX_TOKENS, Math.floor(bytes / 3.8))
const MISS_THRESHOLD = 100_000
const IDLE_MIN_CONTEXT = 150_000
const COMPACT_SUMMARY_TOKENS = 15_000
const LEDGER_DAYS = 90
const RAW_FILE_DAYS = 14
// Avisos de custo ficam mais que os 4 s padrão: dá tempo de ler o valor e a alternativa
const WARN_TOAST_MS = 9_000

// Leituras que só enchem o contexto (o equivalente às regras `deny` de Read que o CATO instalava)
const HEAVY_DIR_RE = /(^|[\\/])(node_modules|dist|build|coverage|\.next|target|\.venv|venv)([\\/]|$)/
const HEAVY_FILE_RE = /(^|[\\/])(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|uv\.lock)$|\.min\.(js|css)$/
// O grafo bruto e o cache do Graphify: o resumo está no GRAPH_REPORT.md e a consulta no graph_query
const GRAPHIFY_HEAVY_RE = /(^|[\\/])graphify-out[\\/](graph\.json|cache([\\/]|$))/
const SENSITIVE_RE = /(^|[\\/])(\.env(\..*)?|id_rsa[^\\/]*|id_ed25519[^\\/]*|[^\\/]*\.(pem|key|p12|pfx)|[^\\/]*(credentials|secret)[^\\/]*)$/i
// Respostas MCP que não viram sandbox: as do próprio CATO, as de navegação/tela (imagens, estado de página) e
// as do app (sessões, terminal, painéis, tarefas agendadas), que o modelo precisa ler inteiras para agir
const SKIP_MCP =
  /^mcp__(cato|claude[_-]browser|claude[_-]in[_-]chrome|computer[_-]use|playwright|puppeteer|chrome|browser|computer|ccd_[a-z_]+|terminal|visualize|scheduled[_-]tasks|mcp[_-]registry|plugin[_-]authoring)__/i
// Campos com que o modelo já limita a resposta: ele escolheu o tamanho, então ela chega inteira
const MCP_LIMIT_KEYS = ['limit', 'max_results', 'maxResults', 'per_page', 'perPage', 'page_size', 'pageSize', 'max_tokens', 'max_chars', 'max_answer_chars', 'tail_lines', 'fields']
// Prévia de uma resposta guardada: começo e fim, por caracteres (JSON minificado é uma linha só)
const SANDBOX_PREVIEW_CHARS = 1_500

const HEAVY_RETRY = ' If you really need it, make the same call again: the second attempt goes through.'

/** Por que ler este caminho só encheria o contexto, ou null se a leitura é normal. */
function heavyReason(path: string): string | null {
  if (GRAPHIFY_HEAVY_RE.test(path)) {
    return `[CATO] ${path} is Graphify's raw graph. Read ${GRAPHIFY_REPORT} for the overview or use mcp__cato__graph_query for a term.` + HEAVY_RETRY
  }
  if (HEAVY_DIR_RE.test(path) || HEAVY_FILE_RE.test(path)) {
    return `[CATO] ${path} is a dependency, build output or lockfile: reading it only fills the context. ` +
      "Read the project's source instead." + HEAVY_RETRY
  }
  return null
}

// Pasta pesada só pelo nome (build/, dist/, target/...) pode ser código-fonte versionado: o git decide.
// Cache por pasta; fora de um repositório git (ou sem git) vale o nome.
const ignoredDirCache = new Map<string, boolean>()

async function isIgnoredHeavyDir($: EngineInterface, path: string): Promise<boolean> {
  const normalized = path.replace(/\\/g, '/')
  const match = /^(.*?(?:^|\/)(?:node_modules|dist|build|coverage|\.next|target|\.venv|venv))(?:\/|$)/.exec(normalized)
  if (!match) return false
  const dir = match[1]
  const known = ignoredDirCache.get(dir)
  if (known !== undefined) return known
  const r = await $.process.run(['git', 'check-ignore', '-q', dir], { timeoutMs: 3000 }).catch(() => null)
  // 0: ignorado; 1: versionado ou não ignorado; outro código: não é repositório git ou não há git
  const ignored = !r || r.exitCode !== 1
  ignoredDirCache.set(dir, ignored)
  return ignored
}

// Texto do último prompt digitado: um caminho citado nele foi pedido pela pessoa, e a leitura passa
let lastPromptText = ''

/** Caminho relativo à raiz do projeto (`cwd`), com `/` e sem `./` inicial; fora do projeto, o caminho normalizado. */
async function projectRelative($: EngineInterface, path: string): Promise<string> {
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  const cwd = ((await $.session.cwd().catch(() => '')) || '').replace(/\\/g, '/').replace(/\/$/, '')
  if (cwd && normalized.toLowerCase().startsWith(`${cwd.toLowerCase()}/`)) {
    return normalized.slice(cwd.length + 1).replace(/^(?:\.\/)+/, '')
  }
  return normalized
}

/**
 * Motivo para negar a leitura de `path` pela ferramenta `tool`, ou null para deixar passar. Nega só na primeira
 * tentativa: repetir a mesma chamada, ou citar o caminho no prompt, libera (o modelo nunca fica travado).
 */
async function heavyDenial($: EngineInterface, tool: string, path: string): Promise<string | null> {
  const rel = await projectRelative($, path)
  const reason = heavyReason(rel) ? heavyReason(path) ?? heavyReason(rel) : null
  if (!reason) return null
  const normalized = path.replace(/\\/g, '/')
  const base = rel.split('/').pop() ?? rel
  const prompt = lastPromptText.toLowerCase()
  if (
    prompt &&
    (prompt.includes(rel.toLowerCase()) ||
      prompt.includes(normalized.toLowerCase()) ||
      (base.length > 3 && prompt.includes(base.toLowerCase())))
  ) {
    return null
  }
  const key = `heavy:${tool}:${rel.toLowerCase()}`
  if (acks.has(key)) {
    // Pedido de novo: a leitura entra e a economia creditada na negação sai do relatório
    const credit = heavyCredit.get(key) ?? 0
    heavyCredit.delete(key)
    await bumpDay($, day => {
      day.blockedReads -= 1
      day.blockedTokens -= credit
    })
    return null
  }
  const byNameOnly = !GRAPHIFY_HEAVY_RE.test(rel) && !HEAVY_FILE_RE.test(rel)
  if (byNameOnly && !(await isIgnoredHeavyDir($, rel))) return null
  acks.add(key)
  return reason
}

// -------------------------------------------------------------------------------------------------------
// Cache aquecido (experimental, opção warmCache): com contexto grande e a sessão parada, uma pergunta mínima
// por fork pouco antes do TTL expirar relê o prefixo em cache (≈ 0,1× o preço de entrada) e o mantém vivo,
// em vez de uma reescrita (1,25× ou 2×) quando a pessoa voltar. No máximo WARM_MAX por pausa.
// -------------------------------------------------------------------------------------------------------
const WARM_MAX = 2
const WARM_LEAD_MS = 3 * 60_000
const WARM_PROMPT = 'Cache keep-alive from the CATO plugin. Reply with only: ok'
let warmTimer: { cancel: () => void } | null = null
let warmsThisPause = 0
// Última chamada real (não de aquecimento) antes da pausa: decide se a volta teria encontrado o cache frio
let pauseSince = 0

function cancelWarm(): void {
  warmTimer?.cancel()
  warmTimer = null
}

async function scheduleWarm($: EngineInterface): Promise<void> {
  cancelWarm()
  const { warmCache } = await experimentalFlags($).catch(() => ({ warmCache: !!options.warmCache }))
  if (!warmCache || warmsThisPause >= WARM_MAX || lastCtx < IDLE_MIN_CONTEXT || ttlMs <= WARM_LEAD_MS) return
  try {
    warmTimer = $.clock.after(ttlMs - WARM_LEAD_MS, () => void warmNow($).catch(() => undefined))
  } catch {
    warmTimer = null
  }
}

// Enquanto o fork de aquecimento roda, o turn.step dele (se houver) não conta como volta da pessoa
let warming = false

async function warmNow($: EngineInterface): Promise<void> {
  warmTimer = null
  const now = await $.clock.now()
  // Houve atividade depois do agendamento: o cache já está quente
  if (now - lastStepAt < ttlMs - WARM_LEAD_MS - 1000 || compactedAt > lastStepAt) return
  const stepBefore = lastStepAt
  warming = true
  const r = await $.model.fork({ prompt: WARM_PROMPT }).catch(() => null).finally(() => { warming = false })
  if (!r || !('usage' in r) || !r.usage) return
  const usage = r.usage as unknown as StepUsage
  const cost = usageCost(lastModel, usage, options.cacheTtlMinutes) ?? 0
  warmsThisPause += 1
  // Se o fork não passou pelo turn.step, o custo ainda não está no total do dia
  const counted = lastStepAt !== stepBefore
  if (!counted) lastStepAt = await $.clock.now()
  await bumpDay($, day => {
    day.warms += 1
    day.warmCost += cost
    if (!counted) {
      day.calls += 1
      day.cost += cost
    }
  })
  await saveSnapshot($)
  await scheduleWarm($)
}

/** Na volta da pessoa: credita a reescrita evitada se, sem os aquecimentos, o cache teria expirado. */
async function settleWarm($: EngineInterface, now: number, model: string): Promise<void> {
  cancelWarm()
  if (warmsThisPause > 0 && pauseSince && now - pauseSince > ttlMs && now - lastStepAt <= ttlMs) {
    const write = writePrice(model)
    const read = priceFor(model)?.read
    if (write !== null && read !== undefined) {
      const avoided = (lastCtx * (write - read)) / 1e6
      await bumpDay($, day => { day.warmSaved += Math.max(0, avoided) })
    }
  }
  warmsThisPause = 0
}

// Tokens creditados em cada negação de leitura pesada, descontados se a mesma leitura for pedida de novo
const heavyCredit = new Map<string, number>()
// O mesmo para respostas MCP guardadas em sandbox e pedidas de novo
const sandboxCredit = new Map<string, number>()

const sandboxMinTokens = (): number => Math.max(500, Number(options.sandboxMinTokens) || 6_000)

let sandboxSkipRe: RegExp | null | undefined
/** Ferramentas MCP que a pessoa quer sempre inteiras (opção `sandboxSkip`, regex sobre o nome da ferramenta). */
function sandboxSkipped(tool: string): boolean {
  if (sandboxSkipRe === undefined) {
    const raw = String(options.sandboxSkip ?? '').trim()
    try {
      sandboxSkipRe = raw ? new RegExp(raw, 'i') : null
    } catch {
      sandboxSkipRe = null
    }
  }
  return !!sandboxSkipRe && sandboxSkipRe.test(tool)
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
// Idioma do que a pessoa lê, detectado no início da sessão e a cada comando do CATO
let lang: Lang = 'en'
let langSource: keyof Messages['doctor']['langSources'] = 'default'
const t = (): Messages => MESSAGES[lang]
const fmt = (): Fmt => formatter(lang)
// readGuard: tokens creditados em cada desvio, descontados se o arquivo inteiro for pedido de novo
const readGuardCredit = new Map<string, number>()
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

// Gravações no $.store em fila: hooks concorrentes (subagentes em paralelo, várias ferramentas) não se
// sobrescrevem, e as mudanças que chegam enquanto uma gravação roda saem juntas na seguinte
let storeChain: Promise<void> = Promise.resolve()
let pendingDays: ((day: Day) => void)[] = []
let pendingSnapshot = false

function serial($: EngineInterface): Promise<void> {
  storeChain = storeChain.then(() => drainStore($)).catch(() => undefined)
  return storeChain
}

async function drainStore($: EngineInterface): Promise<void> {
  const changes = pendingDays
  const snapshot = pendingSnapshot
  pendingDays = []
  pendingSnapshot = false
  if (changes.length) {
    // Lê o valor atual logo antes de gravar: outra sessão pode ter gravado no meio tempo
    const ledger = await loadLedger($)
    const key = dayKey(await $.clock.now())
    const day = { ...emptyDay(), ...(ledger.days[key] ?? {}) }
    for (const change of changes) change(day)
    ledger.days[key] = day
    const keys = Object.keys(ledger.days).sort()
    for (const old of keys.slice(0, Math.max(0, keys.length - LEDGER_DAYS))) delete ledger.days[old]
    await $.store.set(LEDGER_KEY, ledger)
  }
  if (snapshot) await writeSnapshot($)
  await writeFixed($)
}

function bumpDay($: EngineInterface, change: (day: Day) => void): Promise<void> {
  pendingDays.push(change)
  return serial($)
}

// -------------------------------------------------------------------------------------------------------
// Custo fixo medido (só observa: o que vai para a API não muda). Descrições de ferramentas por provedor na
// sessão atual e lembretes injetados pelo motor por tipo, em caracteres; nunca o texto. Base para cortes.
// -------------------------------------------------------------------------------------------------------
const FIXED_KEY = 'fixed'
type FixedRow = { count: number; chars: number; deferred?: number }
type Fixed = { tools: Record<string, FixedRow>; attachments: Record<string, FixedRow> }
const seenTools = new Map<string, { provider: string; chars: number; deferred: boolean }>()
let toolsDirty = false
const pendingAttachments: Record<string, FixedRow> = {}

async function loadFixed($: EngineInterface): Promise<Fixed> {
  const raw = (await $.store.get(FIXED_KEY).catch(() => undefined)) as Partial<Fixed> | undefined
  return { tools: raw?.tools ?? {}, attachments: raw?.attachments ?? {} }
}

async function writeFixed($: EngineInterface): Promise<void> {
  const attachmentTypes = Object.keys(pendingAttachments)
  if (!toolsDirty && !attachmentTypes.length) return
  const fixed = await loadFixed($)
  if (toolsDirty) {
    const tools: Record<string, FixedRow> = {}
    for (const { provider, chars, deferred } of seenTools.values()) {
      const row = (tools[provider] ??= { count: 0, chars: 0, deferred: 0 })
      row.count += 1
      row.chars += chars
      if (deferred) row.deferred = (row.deferred ?? 0) + 1
    }
    fixed.tools = tools
    toolsDirty = false
  }
  for (const type of attachmentTypes) {
    const row = (fixed.attachments[type] ??= { count: 0, chars: 0 })
    row.count += pendingAttachments[type].count
    row.chars += pendingAttachments[type].chars
    delete pendingAttachments[type]
  }
  await $.store.set(FIXED_KEY, fixed)
}

function providerName(provider: unknown): string {
  if (!provider || typeof provider !== 'object') return String(provider ?? 'unknown')
  const p = provider as { kind?: string; name?: string; server?: string; plugin?: string; tier?: string }
  return String(p.name ?? p.server ?? p.plugin ?? p.kind ?? 'unknown')
}

// -------------------------------------------------------------------------------------------------------
// Retrato do cache da conversa principal por sessão: o guard continua sabendo quando foi a última chamada
// depois de um reload do módulo ou de reabrir o app (as variáveis do módulo recomeçam do zero)
// -------------------------------------------------------------------------------------------------------
const SESSIONS_KEY = 'sessions'
const MAX_SESSIONS = 50
type Snapshot = { lastStepAt: number; lastModel: string; lastCtx: number; compactedAt: number }

async function sessionId($: EngineInterface): Promise<string | null> {
  try {
    const id = await $.session.id()
    return id ? String(id) : null
  } catch {
    return null
  }
}

async function loadSessions($: EngineInterface): Promise<Record<string, Snapshot>> {
  const raw = await $.store.get(SESSIONS_KEY).catch(() => undefined)
  return raw && typeof raw === 'object' ? (raw as Record<string, Snapshot>) : {}
}

async function writeSnapshot($: EngineInterface): Promise<void> {
  const id = await sessionId($)
  if (!id) return
  const sessions = await loadSessions($)
  delete sessions[id] // reinsere no fim: as mais antigas saem primeiro
  sessions[id] = { lastStepAt, lastModel, lastCtx, compactedAt }
  const ids = Object.keys(sessions)
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) delete sessions[old]
  await $.store.set(SESSIONS_KEY, sessions)
}

function saveSnapshot($: EngineInterface): Promise<void> {
  pendingSnapshot = true
  return serial($)
}

/** Recupera o retrato desta sessão se o módulo acabou de carregar (nada medido ainda nesta vida do módulo). */
async function restoreSnapshot($: EngineInterface): Promise<void> {
  if (lastStepAt) return
  const id = await sessionId($)
  const saved = id ? (await loadSessions($))[id] : undefined
  if (!saved || !(Number(saved.lastStepAt) > 0)) return
  lastStepAt = Number(saved.lastStepAt)
  lastModel = String(saved.lastModel ?? '')
  lastCtx = Number(saved.lastCtx) || 0
  compactedAt = Number(saved.compactedAt) || 0
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
// Idioma: opção `language` do CATO; senão o `language` do Claude Code (texto livre, como "portuguese");
// senão o locale do sistema; senão inglês. Um valor configurado mas não suportado também cai no inglês.
// -------------------------------------------------------------------------------------------------------
let langDetected = false

/** Popups e status: detecta uma vez se ainda não houve sessão nem comando (reload do módulo no meio da sessão). */
async function ensureLanguage($: EngineInterface): Promise<void> {
  if (!langDetected) await detectLanguage($).catch(() => undefined)
}

async function detectLanguage($: EngineInterface): Promise<void> {
  langDetected = true
  const pick = (value: Lang | null, source: typeof langSource): boolean => {
    if (!value) return false
    lang = value
    langSource = source
    return true
  }
  const option = String(options?.language ?? 'auto').trim()
  if (option && option.toLowerCase() !== 'auto' && pick(langFrom(option) ?? 'en', 'option')) return
  try {
    const cfg = await claudeConfigDir($)
    const cwd = (await $.session.cwd()).replace(/\\/g, '/').replace(/\/$/, '')
    // Precedência do Claude Code: local > projeto > usuário
    for (const path of [`${cwd}/.claude/settings.local.json`, `${cwd}/.claude/settings.json`, `${cfg}/settings.json`]) {
      const value = (await readJson($, path))?.language
      if (typeof value === 'string' && value.trim() && pick(langFrom(value) ?? 'en', 'claude')) return
    }
  } catch {
    // sem projeto ou sem settings: segue para o sistema
  }
  const system = [
    await $.env.get('LC_ALL').catch(() => undefined),
    await $.env.get('LC_MESSAGES').catch(() => undefined),
    await $.env.get('LANG').catch(() => undefined),
  ].find(v => v && !/^(c|posix)([._]|$)/i.test(v))
  let intl: string | undefined
  try {
    intl = Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    intl = undefined
  }
  const fromSystem = system ?? intl
  if (fromSystem && pick(langFrom(fromSystem) ?? 'en', 'system')) return
  pick('en', 'default')
}

// -------------------------------------------------------------------------------------------------------
// Status: contexto, custo do próximo turno e quanto falta para o cache expirar (convive com a statusLine)
// -------------------------------------------------------------------------------------------------------
async function refreshStatus($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const ctx = usage.context?.tokens ?? lastCtx
  if (!ctx) return $.ui.status(undefined)
  const model = lastModel || (await $.session.model())
  const price = priceFor(model)
  const write = writePrice(model)
  await ensureLanguage($)
  const m = t().status
  const f = fmt()
  const parts = [`CATO · ctx ${f.tokens(ctx)}`]
  if (compactedAt > lastStepAt) {
    parts.push(m.compacted)
  } else if (lastStepAt) {
    const idle = (await $.clock.now()) - lastStepAt
    if (idle > ttlMs) {
      parts.push(write !== null ? m.coldNext(f.money((ctx * write) / 1e6)) : m.cold)
    } else {
      if (price) parts.push(m.next(f.money((ctx * price.read) / 1e6, 3)))
      parts.push(m.expiresIn(String(Math.ceil((ttlMs - idle) / 60_000))))
    }
  }
  if (usage.cost) parts.push(m.session(f.money(usage.cost.usd)))
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
      return `[CATO] The JSON in ${path} is now invalid: ${(error as Error).message}. Fix it with Edit.`
    }
  }
  if (lower.endsWith('.py') && options.pythonChecks) {
    const py = await findPython($)
    if (!py) return null
    const r = await $.process.run([py, '-m', 'py_compile', path], { timeoutMs: 10_000 })
    if (r.exitCode === 0) return null
    const detail = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')
    return `[CATO] The edit to ${path} introduced a syntax error: ${detail}. Fix it with Edit; no need to run Bash.`
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
    throw new Error(`${path} is outside the project (${root}).`)
  }
  if (SENSITIVE_RE.test(absolute)) throw new Error(`${path} looks like it holds secrets; CATO does not read it.`)
  const { decision } = await $.tool.check({ tool: 'Read', input: { file_path: absolute } })
  if (decision === 'deny') throw new Error(`${path} is blocked by your Read permission rules.`)
  return absolute
}

const LOW_PRIORITY_PATH_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|fixtures|examples|migrations|benchmarks)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i

function compareCodePaths(a: string, b: string): number {
  const lowA = LOW_PRIORITY_PATH_RE.test(a) ? 1 : 0
  const lowB = LOW_PRIORITY_PATH_RE.test(b) ? 1 : 0
  if (lowA !== lowB) return lowA - lowB
  const depthA = a.split('/').length
  const depthB = b.split('/').length
  if (depthA !== depthB) return depthA - depthB
  return a.localeCompare(b)
}

async function listCodeFiles($: EngineInterface, limit: number): Promise<string[]> {
  const listed = await git($, ['ls-files', '--cached', '--others', '--exclude-standard'])
  if (listed) {
    return listed
      .split('\n')
      .filter(p => p && isCodeFile(p) && !p.split('/').some(part => IGNORED_DIRS.has(part)))
      .sort(compareCodePaths)
      .slice(0, limit)
  }
  const found: string[] = []
  const pending = ['']
  const scanLimit = limit * 2
  while (pending.length && found.length < scanLimit) {
    const dir = pending.shift()!
    for (const entry of await $.fs.list(dir || undefined)) {
      const path = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.kind === 'dir' && !IGNORED_DIRS.has(entry.name)) pending.push(path)
      else if (entry.kind === 'file' && isCodeFile(entry.name) && found.length < scanLimit) found.push(path)
    }
  }
  return found.sort(compareCodePaths).slice(0, limit)
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
  const paths = await listCodeFiles($, 300)
  for (let i = 0; i < paths.length; i += 25) {
    const batch = await Promise.all(paths.slice(i, i + 25).map(async path => {
      try {
        if ((await $.fs.stat(path)).size > 200_000) return null
        return [path, (await $.fs.read(path)) as string] as const
      } catch {
        // arquivo sumiu ou é ilegível: segue
        return null
      }
    }))
    for (const item of batch) {
      if (item) files.set(item[0], item[1])
    }
  }
  const graph = await loadGraph($)
  const map = buildRepoMap(files, focus, budget, graph ? graphFileEdges(graph) : undefined)
  return graph ? `${map}\n\n[Ranking reinforced by the Graphify graph: ${graph.links.length} relations. Overview in ${GRAPHIFY_REPORT}.]` : map
}

async function graphQuery($: EngineInterface, term: string, limit: number): Promise<string> {
  const graph = await loadGraph($)
  if (graph) return queryGraph(graph, term, limit)
  const exists = await $.fs.exists(GRAPHIFY_JSON).catch(() => false)
  return exists
    ? `${GRAPHIFY_JSON} exists but could not be read (invalid or over 4 MiB). Use the Graphify MCP or ${GRAPHIFY_REPORT}.`
    : 'This project has no Graphify graph (graphify-out/graph.json). Build one with /graphify . or use mcp__cato__repo_map.'
}

// ast-grep: `ast-grep` e, no Windows/macOS, o atalho `sg` (no Linux `sg` costuma ser o setgroups, por isso a checagem)
async function findAstGrep($: EngineInterface): Promise<string | null> {
  // Só o achado fica guardado: instalado com a sessão aberta, passa a valer na próxima chamada
  if (astGrep) return astGrep
  const works = async (candidate: string) => {
    const r = await $.process.run([candidate, '--version'], { timeoutMs: 5000 }).catch(() => null)
    return !!r && r.exitCode === 0 && /ast-grep/i.test(r.stdout + r.stderr)
  }
  for (const candidate of ['ast-grep', 'sg']) if (await works(candidate)) return (astGrep = candidate)
  // Fora do PATH: o binário do `npm i -g @ast-grep/cli` (Windows) e do `cargo install ast-grep`
  const appData = (await $.env.get('APPDATA').catch(() => undefined))?.replace(/\\/g, '/')
  const home = await homeDir($).catch(() => null)
  const installed = [
    ...(appData ? [`${appData}/npm/node_modules/@ast-grep/cli/ast-grep.exe`] : []),
    ...(home ? [`${home}/.cargo/bin/ast-grep.exe`, `${home}/.cargo/bin/ast-grep`] : []),
  ]
  for (const path of installed) {
    if ((await $.fs.exists(path).catch(() => false)) && (await works(path))) return (astGrep = path)
  }
  return null
}

async function structuralSearch($: EngineInterface, input: { pattern: string; lang?: string; path?: string; max_results?: number }): Promise<string> {
  const bin = await findAstGrep($)
  if (!bin) return 'ast-grep is not installed (npm i -g @ast-grep/cli, cargo install ast-grep, brew install ast-grep). Use Grep meanwhile.'
  const root = (await $.session.cwd()).replace(/\\/g, '/').replace(/\/$/, '')
  const target = String(input.path || '.').replace(/\\/g, '/')
  const absolute = /^([A-Za-z]:)?\//.test(target) ? target : `${root}/${target}`
  if (absolute.split('/').includes('..') || !(`${absolute}/`.toLowerCase().startsWith(`${root.toLowerCase()}/`))) {
    throw new Error(`${target} is outside the project (${root}).`)
  }
  if (SENSITIVE_RE.test(absolute)) throw new Error(`${target} looks like it holds secrets; CATO does not read it.`)
  const reason = await heavyDenial($, 'structural_search', target)
  if (reason) throw new Error(reason.replace('[CATO] ', ''))
  const args = [bin, 'run', '--pattern', input.pattern, '--json=stream', ...(input.lang ? ['--lang', input.lang] : []), target]
  const r = await $.process.run(args, { timeoutMs: 30_000 })
  if (r.exitCode !== 0 && !r.stdout.trim()) return `ast-grep failed: ${(r.stderr || 'no output').trim().slice(0, 600)}`
  const max = Number(input.max_results) || options.astGrepMaxResults || 60
  return formatAstGrepMatches(r.stdout, max) ?? r.stdout.slice(0, 20_000)
}

async function readSymbol($: EngineInterface, filePath: string, symbol: string): Promise<string> {
  const path = await readableProjectFile($, filePath)
  const found = extractSymbol(path, (await $.fs.read(path)) as string, symbol)
  if (!found) return `Symbol '${symbol}' not found in ${filePath}.`
  return `# [CATO Symbol Extract: ${symbol} in ${filePath} (L${found.start}-L${found.end})]\n${found.text}`
}

async function searchSandbox($: EngineInterface, id: string, query: string): Promise<string> {
  const home = await homeDir($)
  const chunks: SandboxChunk[] = id.startsWith('sbx_')
    ? (JSON.parse((await $.fs.read(`${home}/.cato/sandbox/${id}.json`)) as string) as { chunks: SandboxChunk[] }).chunks
    : chunkLines((await $.fs.read(`${home}/.cato/logs/${id}.log`)) as string)
  const hits = bm25Search(chunks, query)
  return hits.length ? hits.map(h => `=== [${h.title}] ===\n${h.content}`).join('\n\n') : `No results for '${query}' in ${id}.`
}

/** Economia do RTK nos dias pedidos (`rtk gain --daily --format json`), ou null sem RTK. */
async function rtkSavings($: EngineInterface, keys: string[]): Promise<{ commands: number; saved: number } | null> {
  const r = await $.process.run(['rtk', 'gain', '--daily', '--format', 'json'], { timeoutMs: 5_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) return null
  try {
    const daily = (JSON.parse(r.stdout) as { daily?: { date?: string; commands?: number; saved_tokens?: number }[] }).daily ?? []
    const wanted = new Set(keys)
    const total = { commands: 0, saved: 0 }
    for (const d of daily) {
      if (!d.date || !wanted.has(d.date)) continue
      total.commands += Number(d.commands) || 0
      total.saved += Number(d.saved_tokens) || 0
    }
    return total
  } catch {
    return null
  }
}

async function costReport($: EngineInterface, days: number, width = 100): Promise<string> {
  const ledger = await loadLedger($)
  const history = await loadHistory($)
  const now = await $.clock.now()
  const m = t().report
  const f = fmt()
  // O histórico importado só tem dias anteriores ao ledger ao vivo (liveSince), então somar não conta duas vezes
  const sum = (n: number): Day => {
    const total = emptyDay()
    for (const key of lastDayKeys(now, n)) {
      addDay(total, ledger.days[key])
      addDay(total, history?.days[key])
    }
    return total
  }
  const period = sum(days)
  const row = (label: string, d: Day) => [
    label,
    f.money(d.cost),
    f.int(d.calls),
    f.tokens(d.read + d.write + d.output),
    f.tokens(d.calls ? d.ctxSum / d.calls : 0),
    f.tokens(d.maxCtx),
  ]
  const out = [...heading(m.title(t().days(days))), m.subtitle, '']
  out.push(
    ...table(
      [m.cols, row(m.today, sum(1)), row(t().days(7), sum(7)), ...(days === 1 || days === 7 ? [] : [row(t().days(days), period)])],
      [false, true, true, true, true, true],
    ),
  )
  if (period.subCalls) {
    const share = period.subCost / Math.max(period.cost + period.subCost, 1e-9)
    out.push('', ...wrap(m.subagents(f.money(period.subCost), f.int(period.subCalls), f.pct(share)), width, '  '))
  }

  out.push('', `▸ ${m.missesTitle}`)
  out.push(
    ...table(
      [
        m.missCols,
        [m.missIdle, `${f.int(period.missIdle)}×`, f.money(period.missIdleCost)],
        [m.missModel, `${f.int(period.missModel)}×`, f.money(period.missModelCost)],
        [m.missOther, `${f.int(period.missOther)}×`, f.money(period.missOtherCost)],
      ],
      [false, true, true],
    ),
  )
  out.push(...wrap(m.rebuilds(f.int(period.rebuilds), f.money(period.rebuildCost)), width, '  '))
  if (period.subMisses) out.push(...wrap(m.subMisses(f.int(period.subMisses), f.money(period.subMissCost)), width, '  '))
  if (period.unpriced) out.push(...wrap(m.unpriced(f.int(period.unpriced)), width, '  '))

  if (period.cost > 0) {
    out.push('', `▸ ${m.bandsTitle}`)
    out.push(
      ...table(
        [
          m.bandCols,
          ...BAND_LABELS.map((label, i) => {
            const cost = period[`band${i as 0 | 1 | 2 | 3}`]
            return [label, f.money(cost), f.pct(cost / period.cost)]
          }),
        ],
        [false, true, true],
      ),
    )
  }

  // Cada token poupado entraria no contexto como escrita de cache; nos turnos seguintes ainda seria relido
  const price = priceFor(lastModel) ?? priceFor('opus')!
  const entryPrice = options.cacheTtlMinutes >= 60 ? price.write1h : price.write5m
  const savings: [string, number, number, string?][] = [
    [m.saved.compressed, period.compressions, period.compressedTokens],
    [m.saved.sandbox, period.sandboxed, period.sandboxTokens],
    [m.saved.blocked, period.blockedReads, period.blockedTokens, m.blockedNote],
    [m.saved.readGuard, period.readGuardDenies, period.readGuardTokens, m.readGuardNote(f.int(period.readGuardBypass))],
    [m.saved.masked, period.masks, period.maskedTokens],
  ]
  const rtk = await rtkSavings($, lastDayKeys(now, days))
  if (rtk) savings.unshift([m.saved.rtk, rtk.commands, rtk.saved])
  const savedTokens = savings.reduce((n, [, , tokens]) => n + tokens, 0)
  const shown = savings.filter(([, count]) => count > 0)
  out.push('', `▸ ${m.savingsTitle}`, ...wrap(m.savingsNote, width, '  '))
  if (shown.length) {
    const withNotes = shown.some(([, , , note]) => note)
    out.push(
      ...table(
        [
          withNotes ? [...m.savingsCols, ''] : m.savingsCols,
          ...shown.map(([label, count, tokens, note]) => {
            const cells = [label, `${f.int(count)}×`, f.tokens(tokens)]
            return withNotes ? [...cells, note ? `(${note})` : ''] : cells
          }),
        ],
        [false, true, true, false],
      ),
    )
    out.push('', ...wrap(m.savingsTotal(f.tokens(savedTokens), f.money((savedTokens * entryPrice) / 1e6)), width, '  '))
    out.push(...wrap(m.savingsLater, width, '  '))
  } else {
    out.push(`  ${m.noSavings}`)
  }
  if (period.guardHolds) out.push(...wrap(m.held(f.int(period.guardHolds)), width, '  '))

  const recs: string[] = []
  if (period.cost > 0 && period.missIdleCost / period.cost > 0.03) recs.push(m.recs.idle)
  if (period.cost > 0 && period.missModelCost / period.cost > 0.02) recs.push(m.recs.model)
  if (period.calls && period.ctxSum / period.calls > 300_000) recs.push(m.recs.avgCtx)
  const outputPrice = priceFor(lastModel)?.output
  if (period.cost > 0 && outputPrice && (period.output * outputPrice) / 1e6 / period.cost > 0.1) recs.push(m.recs.output)
  if (period.subCost > 0 && period.subCost / (period.cost + period.subCost) > 0.3) recs.push(m.recs.subagents)
  if (period.readGuardDenies >= 5 && period.readGuardBypass / period.readGuardDenies > 0.3) recs.push(m.recs.readGuard)
  if (period.cost > 0 && period.band3 / period.cost > 0.3) recs.push(m.recs.band400)
  if (period.warms > 0) {
    out.push('', ...wrap(m.warmLine(f.int(period.warms), f.money(period.warmCost), f.money(period.warmSaved)), width))
  }
  if (recs.length) out.push('', `▸ ${m.recsTitle}`, ...recs.flatMap(r => bullet('•', r, width)))

  out.push('')
  if (!period.calls && !period.subCalls) out.push(...wrap(m.noCalls, width))
  out.push(...wrap(history?.calls ? m.imported(f.int(history.calls), f.date(dayKey(history.first)), f.date(dayKey(history.last))) : m.importHint, width))
  out.push(m.periodHint)
  return out.join('\n')
}

// -------------------------------------------------------------------------------------------------------
// Import do histórico (/cato importar): transcripts anteriores à instalação, sem contar nada duas vezes
// -------------------------------------------------------------------------------------------------------
// `extractor`: com qual extrator falhou; com outro disponível, o arquivo é tentado de novo
type ImportedFile = { size: number; mtimeMs: number; status: 'done' | 'skipped' | 'failed'; calls: number; note?: string; extractor?: string }

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
  pending?: { path: string; size: number; mtimeMs: number; extractor?: string }
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

type Extractor = { kind: 'awk' | 'powershell'; bin: string } | null

/** Onde fica o awk que vem com o Git for Windows (o PATH do app costuma ter só o `Git/cmd`). */
async function gitAwkCandidates($: EngineInterface): Promise<string[]> {
  const found: string[] = []
  const r = await $.process.run(['git', '--exec-path'], { timeoutMs: 5_000 }).catch(() => null)
  // C:/Program Files/Git/mingw64/libexec/git-core -> C:/Program Files/Git/usr/bin/awk.exe
  const root = r?.exitCode === 0 ? r.stdout.trim().replace(/\\/g, '/').match(/^(.*)\/mingw(?:32|64)\/libexec\/git-core$/i)?.[1] : null
  if (root) found.push(`${root}/usr/bin/awk.exe`)
  for (const base of [await $.env.get('ProgramFiles'), await $.env.get('LOCALAPPDATA')]) {
    if (base) found.push(`${base.replace(/\\/g, '/')}${/local$/i.test(base) ? '/Programs' : ''}/Git/usr/bin/awk.exe`)
  }
  return [...new Set(found)]
}

async function findExtractor($: EngineInterface): Promise<Extractor> {
  const works = async (argv: string[]) => {
    const r = await $.process.run(argv, { timeoutMs: 15_000 }).catch(() => null)
    return !!r && r.exitCode === 0 && r.stdout.trim() === 'ok'
  }
  // awk é ~10x mais rápido que o PowerShell nos arquivos grandes
  for (const bin of ['awk', ...(await gitAwkCandidates($))]) {
    if (bin !== 'awk' && !(await $.fs.exists(bin).catch(() => false))) continue
    if (await works([bin, 'BEGIN { print "ok" }'])) return { kind: 'awk', bin }
  }
  if (await works(['powershell', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output ok'])) return { kind: 'powershell', bin: 'powershell' }
  return null
}

// Falha que não diz nada sobre o arquivo (interrompido, tempo esgotado): tenta de novo na próxima vez
const TRANSIENT_RE = /abort|timed? ?out|timeout|cancel/i
const INLINE_READ_LIMIT = 256 * 1024

async function readTranscript($: EngineInterface, file: TranscriptFile, extractor: Extractor): Promise<TranscriptEvent[] | string> {
  if (file.size > 0 && file.size <= INLINE_READ_LIMIT) {
    const inline = await $.fs.read(file.path).catch(() => null)
    if (typeof inline === 'string' && inline.length > 0) return parseJsonlText(inline)
  }
  if (extractor) {
    const argv = extractor.kind === 'awk'
      ? [extractor.bin, AWK_EXTRACT, file.path]
      : [extractor.bin, '-NoProfile', '-NonInteractive', '-Command', powershellExtract(file.path)]
    const r = await $.process.run(argv, { timeoutMs: 180_000 }).catch((error: Error) => error)
    if (r instanceof Error) return `extractor failed: ${r.message.slice(0, 120)}`
    if (r.exitCode !== 0) return `extractor exited with code ${r.exitCode}`
    if (r.isStdoutTruncated) return 'extract over 4 MiB'
    return parseExtract(r.stdout)
  }
  if (file.size > FS_READ_LIMIT) return 'over 4 MiB and no awk/PowerShell to extract it'
  return parseJsonlText((await $.fs.read(file.path)) as string)
}

async function importHistory($: EngineInterface, remainingMs: () => number, width = 100): Promise<string> {
  const ledger = await loadLedger($)
  const now = await $.clock.now()
  const liveDays = Object.keys(ledger.days).sort()
  const history: History = (await loadHistory($)) ?? {
    liveSince: liveDays.length ? dayStart(liveDays[0]) : now,
    days: {}, files: {}, seen: [], calls: 0, first: 0, last: 0,
  }
  if (history.pending) {
    // A execução anterior parou no meio deste arquivo: não tenta de novo enquanto ele não mudar
    const { path, size, mtimeMs, extractor } = history.pending
    history.files[path] = {
      size, mtimeMs, status: 'failed', calls: history.files[path]?.calls ?? 0, note: 'interrupted while reading', extractor: extractor ?? 'fs',
    }
    delete history.pending
  }

  const files = await listTranscripts($)
  const extractor = files.length ? await findExtractor($) : null
  const extractorName = extractor?.kind ?? 'fs'
  // Arquivos novos, que mudaram desde a última vez, ou que falharam com outro extrator (os ids já vistos não contam de novo)
  const todo = files.filter(f => {
    const prev = history.files[f.path]
    if (!prev || prev.size !== f.size || prev.mtimeMs !== f.mtimeMs) return true
    return prev.status !== 'done' && prev.extractor !== extractorName
  })
  const seen = new Set(history.seen)
  let processed = 0
  let added = 0
  let interrupted = 0
  for (const file of todo) {
    if (remainingMs() < 5_000) break
    history.pending = { path: file.path, size: file.size, mtimeMs: file.mtimeMs, extractor: extractorName }
    await $.store.set(HISTORY_KEY, history)
    const events = await readTranscript($, file, extractor).catch((error: Error) => `read failed: ${error.message.slice(0, 120)}`)
    if (typeof events === 'string' && TRANSIENT_RE.test(events)) {
      // Não marca o arquivo: a próxima execução tenta de novo. As chamadas seguintes também seriam cortadas.
      delete history.pending
      await $.store.set(HISTORY_KEY, history)
      interrupted = todo.length - processed
      break
    }
    if (typeof events === 'string') {
      history.files[file.path] = {
        size: file.size, mtimeMs: file.mtimeMs, status: file.size > FS_READ_LIMIT && !extractor ? 'skipped' : 'failed', calls: 0, note: events, extractor: extractorName,
      }
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

  const m = t().import
  const f = fmt()
  const done = Object.values(history.files).filter(file => file.status === 'done').length
  const failed = Object.entries(history.files).filter(([, file]) => file.status !== 'done')
  const remaining = todo.length - processed
  const extractorLabel = !extractor ? m.extractorNone : extractor.bin === 'awk' || extractor.kind === 'powershell' ? extractor.kind : `awk (${extractor.bin})`
  const out = [...heading(m.title)]
  out.push(...wrap(m.summary(f.int(processed), f.int(added), f.int(history.calls), f.int(done)), width))
  out.push(...wrap(m.extractor(extractorLabel), width))
  out.push(...wrap(m.since(f.date(dayKey(history.liveSince))), width))
  if (history.calls) out.push(...wrap(m.period(f.date(dayKey(history.first)), f.date(dayKey(history.last))), width))
  if (interrupted > 0) out.push('', ...wrap(`⚠ ${m.interrupted(f.int(interrupted))}`, width))
  else if (remaining > 0) out.push('', ...wrap(`⚠ ${m.remaining(f.int(remaining))}`, width))
  if (failed.length) {
    out.push('', m.failed(f.int(failed.length)))
    for (const [path, file] of failed.slice(0, 5)) out.push(...bullet('•', `${path.split('/').slice(-2).join('/')}: ${file.note ?? file.status}`, width))
    if (failed.length > 5) out.push(`  ${m.more(f.int(failed.length - 5))}`)
  }
  out.push('', m.seeReport)
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

async function doctor($: EngineInterface, width = 100): Promise<string> {
  const m = t().doctor
  const f = fmt()
  const out: string[] = [...heading(m.title), m.subtitle]
  const section = (title: string) => out.push('', `▸ ${title}`)
  const ok = (text: string) => out.push(...bullet('✅', text, width))
  const info = (text: string) => out.push(...bullet('•', text, width))
  const warn = (text: string) => out.push(...bullet('⚠️', text, width))
  const bad = (text: string) => out.push(...bullet('❌', text, width))

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

  info(m.language(LANG_NAMES[lang], m.langSources[langSource]))

  section(m.conflicts)
  const legacyHooks = /\bcato\b/i.test(JSON.stringify(settings.map(s => s.hooks ?? {})))
  const legacyMcp = mcpServers.some(name => name.toLowerCase() === 'cato')
  if (legacyHooks || legacyMcp) {
    bad(m.legacyBad([legacyHooks && m.legacyHooks, legacyMcp && m.legacyMcp].filter(Boolean).join(` ${t().and} `)))
  } else {
    ok(m.legacyOk)
  }
  const autoCompactEnv = envOr('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'))
  if (autoCompactEnv && options.autoCompactPercent > 0) warn(m.autoCompactConflict(autoCompactEnv, String(options.autoCompactPercent)))

  section(m.integrations)
  ;(await commandWorks($, ['rtk', '--version'], /rtk/i)) ? ok(m.rtkOk) : info(m.rtkMissing)
  ;(await findAstGrep($)) ? ok(m.astOk) : info(m.astMissing)
  ;(await $.fs.exists(GRAPHIFY_JSON).catch(() => false)) ? ok(m.graphOk) : info(m.graphMissing)
  mcpServers.some(n => /serena/i.test(n)) ? ok(m.serenaOk) : info(m.serenaMissing)
  mcpServers.some(n => /github/i.test(n)) || plugins.some(p => /github/i.test(p)) ? ok(m.githubOk) : info(m.githubMissing)
  if (options.pythonChecks) (await findPython($)) ? ok(m.pythonOk) : info(m.pythonMissing)

  section(m.fixedContext)
  for (const path of [`${cwd}/CLAUDE.md`, `${cwd}/.claude/CLAUDE.md`, `${cfg}/CLAUDE.md`]) {
    const text = await $.fs.read(path).catch(() => null)
    if (typeof text !== 'string') continue
    const lines = text.split('\n').length
    const label = path.startsWith(cfg) ? '~/.claude/CLAUDE.md' : path.slice(cwd.length + 1)
    lines > 200 ? warn(m.claudeMdBig(label, f.int(lines))) : ok(m.claudeMdOk(label, f.int(lines)))
  }
  mcpServers.length > 10 ? warn(m.mcpMany(f.int(mcpServers.length))) : info(m.mcpCount(f.int(mcpServers.length)))
  if (envOr('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', await $.env.get('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'))) warn(m.betasDisabled)
  // Medido nesta máquina: descrições de ferramentas da última sessão e lembretes injetados pelo motor
  await serial($)
  const fixed = await loadFixed($)
  const top = (rows: Record<string, FixedRow>) =>
    Object.entries(rows).sort((a, b) => b[1].chars - a[1].chars).slice(0, 5)
  const tools = top(fixed.tools)
  const reminders = top(fixed.attachments)
  if (!tools.length && !reminders.length) info(m.fixedNone)
  for (const [provider, row] of tools) info(m.fixedTools(provider, f.int(row.count), f.tokens(Math.round(row.chars / 3.8)), f.int(row.deferred ?? 0)))
  for (const [type, row] of reminders) info(m.fixedReminders(type, f.int(row.count), f.tokens(Math.round(row.chars / 3.8))))

  section(m.cache)
  const model = String(setting('model') ?? '')
  if (/opusplan/i.test(model)) warn(m.opusplan)
  const mainTtl = (envOr('FORCE_PROMPT_CACHING_5M', await $.env.get('FORCE_PROMPT_CACHING_5M'))) === '1' ? 5
    : ttlMinutes(envOr('CLAUDE_CODE_PROMPT_CACHE_TTL', await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'))) ?? ttlMinutes(setting('promptCacheTtl'))
  const catoMain = options.cacheTtlMinutes >= 60 ? 60 : 5
  if (mainTtl === null) info(m.mainTtlDefault(String(catoMain)))
  else if (mainTtl !== catoMain) warn(m.mainTtlMismatch(String(mainTtl), String(catoMain)))
  else ok(m.mainTtlOk(String(mainTtl)))
  const subTtl = ttlMinutes(envOr('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'))) ?? ttlMinutes(setting('subagentPromptCacheTtl')) ?? 5
  const catoSub = subagentTtlMinutes() >= 60 ? 60 : 5
  subTtl !== catoSub ? warn(m.subTtlMismatch(String(subTtl), String(catoSub))) : ok(m.subTtlOk(String(subTtl)))
  info(m.idleCompaction(setting('idleCompaction') !== false))

  section(m.data)
  for (const [label, dir] of [[m.sandboxes, `${home}/.cato/sandbox`], [m.logs, `${home}/.cato/logs`]] as const) {
    const { files, bytes } = await folderSize($, dir)
    info(m.folder(label, f.int(files), (bytes / 1e6).toFixed(1), String(RAW_FILE_DAYS)))
  }
  const history = await loadHistory($)
  info(history?.calls ? m.historyImported(f.int(history.calls), f.date(dayKey(history.first)), f.date(dayKey(history.last))) : m.historyMissing)

  section(m.options)
  const flags = await experimentalFlags($)
  info(m.experimentalInEffect(onOff(flags.readGuard), onOff(flags.maskColdCompact), onOff(flags.warmCache)))
  // Valores longos cortados para caber na largura ao lado da maior chave
  const entries = Object.entries(options ?? {})
  const room = Math.max(12, width - 5 - Math.max(0, ...entries.map(([key]) => key.length)))
  const rows = entries.map(([key, value]) => {
    const shown = JSON.stringify(value) ?? String(value)
    return [key, shown.length > room ? `${shown.slice(0, room - 2)}…"` : shown]
  })
  if (rows.length) out.push(...table(rows, [false, false], false))
  return out.join('\n')
}

// -------------------------------------------------------------------------------------------------------
// /cato experimental [ligar|desligar|padrão]: liga os recursos experimentais sem passar pelo /plugin.
// As opções de plugin não são linhas do /config, então $.config.set não as alcança: a escolha fica no
// $.store do CATO e vale por cima da configuração do /plugin até "padrão" devolvê-la.
// -------------------------------------------------------------------------------------------------------
type ExperimentalOverride = { readGuard?: boolean; maskColdCompact?: boolean; warmCache?: boolean }

const EXPERIMENTAL_KEY = 'experimental'
let experimentalOverride: ExperimentalOverride | null = null

async function experimentalFlags($: EngineInterface): Promise<{ readGuard: boolean; maskColdCompact: boolean; warmCache: boolean }> {
  if (!experimentalOverride) {
    const raw = await $.store.get(EXPERIMENTAL_KEY).catch(() => null)
    experimentalOverride = raw && typeof raw === 'object' ? (raw as ExperimentalOverride) : {}
  }
  return {
    readGuard: experimentalOverride.readGuard ?? !!options.readGuard,
    maskColdCompact: experimentalOverride.maskColdCompact ?? !!options.maskColdCompact,
    warmCache: experimentalOverride.warmCache ?? !!options.warmCache,
  }
}

const onOff = (value: boolean): string => (value ? t().on : t().off)

async function toggleExperimental($: EngineInterface, action: string, width = 100): Promise<string> {
  const parts = action.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const flagMap: Record<string, keyof ExperimentalOverride> = {
    readguard: 'readGuard',
    maskcoldcompact: 'maskColdCompact',
    warmcache: 'warmCache',
  }
  const targetFlag = parts.length >= 2 ? flagMap[parts[0]] : undefined
  const word = (targetFlag ? parts[1] : parts[0]) ?? ''
  const turnOn = EXPERIMENTAL_WORDS.on.includes(word)
  const turnOff = EXPERIMENTAL_WORDS.off.includes(word)
  const reset = EXPERIMENTAL_WORDS.reset.includes(word)
  if (turnOn || turnOff || reset) {
    await experimentalFlags($)
    if (targetFlag) {
      experimentalOverride = { ...(experimentalOverride ?? {}) }
      if (reset) delete experimentalOverride[targetFlag]
      else experimentalOverride[targetFlag] = turnOn
    } else {
      experimentalOverride = reset ? {} : { readGuard: turnOn, maskColdCompact: turnOn, warmCache: turnOn }
    }
    await $.store.set(EXPERIMENTAL_KEY, experimentalOverride)
    const nextFlags = await experimentalFlags($)
    if (!nextFlags.warmCache) cancelWarm()
    else await scheduleWarm($)
  }
  const m = t().experimental
  const flags = await experimentalFlags($)
  const source = Object.keys(experimentalOverride ?? {}).length ? m.sourceOverride : m.sourcePlugin
  const out = [...heading(m.title), m.state(onOff(flags.readGuard), onOff(flags.maskColdCompact), onOff(flags.warmCache), source)]
  if (turnOn || (!turnOff && !reset)) {
    out.push('', ...bullet('•', m.readGuard, width), ...bullet('•', m.maskColdCompact, width), ...bullet('•', m.warmCache, width))
  }
  if (flags.warmCache) out.push('', ...wrap(`⚠ ${m.keepAliveWarn}`, width))
  if (!turnOn && !turnOff && !reset) out.push('', ...wrap(m.usage, width))
  else if (turnOn) out.push('', ...wrap(m.afterOn, width))
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
  sandboxSkipRe = undefined
  langDetected = false
  experimentalOverride = null
  cancelWarm()
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
            : lastModel && (sameModel(lastModel, usage.model) ?? lastModel === usage.model) === false ? 'model'
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
    await saveSnapshot($)
    if (!warming) {
      pauseSince = now
      warmsThisPause = 0
      await scheduleWarm($)
    }
    return result
  })

  // Medição do custo fixo: observa a resposta do motor e a devolve igual (o prefixo do cache não muda)
  on('tool.describe', async ($, e, next) => {
    const result = await next(e)
    seenTools.set(String(e.tool), {
      provider: providerName(e.provider),
      chars: String(result.description ?? '').length,
      deferred: !!result.isDeferred,
    })
    toolsDirty = true
    void serial($)
    return result
  }).catch(($, e, next) => next(e))

  on('prompt.attachment', async ($, e, next) => {
    const result = await next(e)
    if (typeof result.text === 'string' && result.text) {
      const row = (pendingAttachments[String(e.type)] ??= { count: 0, chars: 0 })
      row.count += 1
      row.chars += result.text.length
      void serial($)
    }
    return result
  }).catch(($, e, next) => next(e))

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
    if (typed && !e.command && !e.isMeta) lastPromptText = String(e.text ?? '').slice(0, 20_000)
    if (typed && !e.command && !e.isMeta && warmsThisPause) {
      await settleWarm($, await $.clock.now(), lastModel || (await $.session.model())).catch(() => undefined)
    }
    if (!options.guard || e.command || e.isMeta || !typed) return next(withPending())
    await restoreSnapshot($).catch(() => undefined)
    if (compactedAt > lastStepAt) return next(withPending())

    const usage = await $.session.usage()
    const ctx = usage.context.tokens ?? lastCtx
    const now = await $.clock.now()
    const model = lastModel || (await $.session.model())
    const price = priceFor(model)
    await ensureLanguage($)
    const f = fmt()

    // Autocompactação (o que CLAUDE_AUTOCOMPACT_PCT_OVERRIDE fazia, agora sem variável de ambiente)
    const pct = usage.context.percent ?? 0
    if (options.autoCompactPercent > 0 && pct >= options.autoCompactPercent) {
      const instructions = compactInstructions()
      const compacted = await $.session
        .compact(instructions ? { instructions } : {})
        .then(r => !('skip' in r && r.skip))
        .catch(() => false)
      if (compacted) {
        $.ui.toast(t().toast.compacted(f.pct(pct / 100)), { timeoutMs: WARN_TOAST_MS })
        return next(withPending())
      }
    }

    // Cache expirado: o próximo turno reescreve o contexto inteiro
    if (lastStepAt && now - lastStepAt > ttlMs && ctx >= IDLE_MIN_CONTEXT) {
      const key = `idle:${lastStepAt}`
      if (!acks.has(key)) {
        acks.add(key)
        const idleMin = f.int(Math.round((now - lastStepAt) / 60_000))
        const write = writePrice(model)
        // Modelo sem preço conhecido: avisa em tokens e nunca segura o prompt por um custo que não sabe calcular
        if (!price || write === null) {
          $.ui.toast(t().toast.coldTokens(idleMin, f.tokens(ctx)), { timeoutMs: WARN_TOAST_MS })
          return next(withPending())
        }
        const rewrite = (ctx * write) / 1e6
        const compactCold = (ctx * price.write5m + COMPACT_SUMMARY_TOKENS * price.output) / 1e6
        if (options.guardBlockUsd > 0 && rewrite >= options.guardBlockUsd) {
          await bumpDay($, day => { day.guardHolds += 1 })
          const h = t().held
          return {
            drop: [
              h.title(idleMin),
              h.cost(f.int(ctx), f.money(rewrite)),
              `  • ${h.clear(f.money(0))}`,
              `  • ${h.compact(f.money(compactCold), f.tokens(COMPACT_SUMMARY_TOKENS))}`,
              `  • ${h.resend}`,
              h.tip,
            ].join('\n'),
          }
        }
        $.ui.toast(t().toast.coldCost(idleMin, f.money(rewrite)), { timeoutMs: WARN_TOAST_MS })
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
          t().toast.modelSwitch(lastModel, current, f.tokens(ctx), write !== null ? f.money((ctx * write) / 1e6) : null),
          { timeoutMs: WARN_TOAST_MS },
        )
      }
    }

    // Contexto grande: só avisa, uma vez por faixa
    const band = bands.filter(b => ctx >= b).pop()
    if (band && !acks.has(`ctx:${band}`)) {
      acks.add(`ctx:${band}`)
      $.ui.toast(
        t().toast.context(f.tokens(ctx), price ? f.money((ctx * price.read) / 1e6, 3) : null, f.tokens(COMPACT_SUMMARY_TOKENS)),
        { timeoutMs: WARN_TOAST_MS },
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
      if (masked.masked) {
        toSummarize = { ...call, messages: masked.messages }
        const chars = (messages: readonly { readonly toolResults?: readonly { readonly text: string }[] }[]) => messages.reduce((n, m) => n + (m.toolResults ?? []).reduce((k, r) => k + r.text.length, 0), 0)
        const saved = Math.floor((chars(call.messages) - chars(masked.messages)) / 3.8)
        await bumpDay($, day => {
          day.masks += 1
          day.maskedTokens += Math.max(0, saved)
        })
      }
    }
    const result = await next(toSummarize)
    if (!('skip' in result && result.skip)) {
      compactedAt = await $.clock.now()
      await saveSnapshot($)
      for (const key of [...acks]) if (key.startsWith('ctx:')) acks.delete(key)
      if (diffStat) {
        pendingContext = `[CATO: uncommitted changes after compaction (git diff --stat)]\n${diffStat.slice(0, 800)}`
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
      const reason = target ? await heavyDenial($, String(e.tool), target) : null
      if (!reason) return next(e)
      // Só o Read tem tamanho conhecido; Grep e Glob negados contam sem tokens
      const size = e.tool === 'Read' ? (await $.fs.stat(target).catch(() => null))?.size ?? 0 : 0
      const rel = await projectRelative($, target)
      heavyCredit.set(`heavy:${String(e.tool)}:${rel.toLowerCase()}`, readTokens(size))
      await bumpDay($, day => {
        day.blockedReads += 1
        day.blockedTokens += readTokens(size)
      })
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
        // O arquivo inteiro entra agora: desconta o que foi creditado no desvio (sobra o custo do esqueleto)
        const full = readGuardCredit.get(key) ?? 0
        readGuardCredit.delete(key)
        await bumpDay($, day => {
          day.readGuardBypass += 1
          day.readGuardTokens -= full
        })
        return next(e)
      }
      const size = (await $.fs.stat(path).catch(() => null))?.size ?? 0
      if (size < READ_GUARD_BYTES || size > FS_READ_LIMIT) return next(e)
      const outline = skeleton(path, (await $.fs.read(path)) as string, 120)
      if (!outline) return next(e)
      acks.add(key)
      const full = readTokens(size)
      readGuardCredit.set(key, full)
      await bumpDay($, day => {
        day.readGuardDenies += 1
        day.readGuardTokens += full - estimateTokens(outline)
      })
      return {
        deny:
          `[CATO] ${target} is ${Math.round(size / 1000)} KB (≈${Math.round(size / 3.8 / 1000)}k tokens). Read only the part you need ` +
          `with offset/limit using the lines below, or mcp__cato__read_symbol. If you need the whole file, call Read again: ` +
          `the second attempt goes through.\n${outline}`,
      }
    }).catch(($, e, next) => (next.called ? Promise.reject(new Error('CATO: failed after the Read')) : next(e)))
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
        ? `\n⚠ [CATO] ${omittedErrors} error lines not shown above. Search the log with ` +
          `mcp__cato__search_sandbox id="${id}" query="error" (or the failure term).`
        : ''
      const footer =
        `${warning}\n[CATO #${id} (${strategy}): ≈${rawTokens} -> ≈${optimized} estimated tokens (−${rawTokens - optimized}). ` +
        `Full raw log: ${logPath}]`
      return { ...ran, result: { ...result, stdout: text + footer } } as typeof ran
    }).catch(($, e, next) => (next.called ? Promise.reject(new Error('CATO: failed after running the command')) : next(e)))
  }

  {
    on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
      const ran = await next(e)
      const path = String((e as unknown as { file_path?: string }).file_path ?? '')
      if (ran.deny !== undefined || ran.isError || !/\.(json|py)$/i.test(path)) return ran
      const problem = await syntaxProblem($, path).catch(() => null)
      return problem ? ({ ...ran, context: [...(ran.context ?? []), problem] } as typeof ran) : ran
    }).catch(($, e, next) => (next.called ? Promise.reject(new Error('CATO: failed after editing the file')) : next(e)))
  }

  // ---------------------------------------------------------------------------------------------------
  // Forks copiam o contexto inteiro: pede um subagente com contexto limpo (o que CLAUDE_CODE_FORK_SUBAGENT=0 fazia)
  // ---------------------------------------------------------------------------------------------------
  on('agent.spawn', ($, e, next) =>
    options.disableForks && e.fork && !e.parentAgentId
      ? {
          deny:
            '[CATO] Fork disabled: it would copy this whole conversation into the subagent. ' +
            'Use a regular subagent (Explore, general-purpose or cato-explorer) with a focused prompt.',
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
    const reason = options.blockHeavyReads && target ? await heavyDenial($, tool, target) : null
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
    if (rawTokens < sandboxMinTokens() || sandboxSkipped(tool)) return current
    // O modelo já limitou a resposta (limit, perPage, fields...): ele escolheu o tamanho
    if (MCP_LIMIT_KEYS.some(key => input[key] !== undefined && input[key] !== null && input[key] !== '')) return current
    // A mesma chamada de novo: o modelo precisa da resposta inteira, e ela entra (a economia creditada sai)
    const { tool_use_id: _id, consent: _consent, ...args } = input
    const repeatKey = `sbx:${tool}:${JSON.stringify(args)}`
    if (acks.has(repeatKey)) {
      const credit = sandboxCredit.get(repeatKey) ?? 0
      sandboxCredit.delete(repeatKey)
      await bumpDay($, day => {
        day.sandboxed -= 1
        day.sandboxTokens -= credit
      })
      return current
    }
    const id = `sbx_${randomId()}`
    const chunks = chunkLines(text)
    const saved = await $.fs
      .write(`${await homeDir($)}/.cato/sandbox/${id}.json`, JSON.stringify({ tool, chunks }))
      .then(() => true)
      .catch(() => false)
    if (!saved) return current
    const lines = text.split('\n')
    const head = text.slice(0, SANDBOX_PREVIEW_CHARS)
    const tail = text.slice(-SANDBOX_PREVIEW_CHARS)
    const omitted = text.length - head.length - tail.length
    const hint = family === 'github'
      ? '\nTip: in the GitHub MCP, `fields`, `perPage`, `detail: "none"` (get_commit) and `tail_lines` (get_job_logs) shrink the response.'
      : ''
    const summary =
      `[CATO MCP Sandbox #${id} — ≈${rawTokens} tokens (estimate) stored in ${chunks.length} chunks]\n` +
      `The response from ${tool} (${lines.length} lines) was indexed to protect the context. ` +
      `Search it with mcp__cato__search_sandbox id="${id}", or repeat the same call to get it whole.${hint}\n\n` +
      (omitted > 0
        ? `--- Start ---\n${head}\n... [${omitted} characters in #${id}] ...\n--- End ---\n${tail}`
        : `--- Preview ---\n${text.slice(0, SANDBOX_PREVIEW_CHARS * 2)}`)
    const credit = Math.max(0, rawTokens - estimateTokens(summary))
    acks.add(repeatKey)
    sandboxCredit.set(repeatKey, credit)
    await bumpDay($, day => {
      day.sandboxed += 1
      day.sandboxTokens += credit
    })
    return withText(ran, summary)
  }).catch(($, e, next) => (next.called ? Promise.reject(new Error('CATO: failed after the MCP call')) : next(e)))

  // ---------------------------------------------------------------------------------------------------
  // Ferramentas do CATO para o modelo e o comando /cato
  // ---------------------------------------------------------------------------------------------------
  on('session.start', async ($, e, next) => {
    await restoreSnapshot($).catch(() => undefined)
    // O conjunto de ferramentas e agentes vai em toda requisição e faz parte do prefixo do cache: é decidido
    // uma vez aqui e não muda no meio da sessão. Ferramenta de integração ausente não é registrada.
    const [hasAstGrep, hasGraph] = await Promise.all([
      findAstGrep($).then(Boolean).catch(() => false),
      $.fs.exists(GRAPHIFY_JSON).catch(() => false),
    ])
    await $.tool.register({
      name: 'repo_map',
      description: 'Ranked repo map (PageRank over symbol use): central files with declarations and [L<start>-L<end>]. Use before several Glob/Grep/Read rounds.',
      inputSchema: {
        type: 'object',
        properties: {
          focus: { type: 'string', description: 'Terms or paths to rank first' },
          token_budget: { type: 'number', description: 'Default 1200' },
        },
      },
    })
    await $.tool.register({
      name: 'read_symbol',
      description: 'Reads one class/function/method (`Class`, `fn`, `Class.method`) with line numbers instead of the whole file.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          symbol: { type: 'string' },
        },
        required: ['file_path', 'symbol'],
      },
    })
    await $.tool.register({
      name: 'search_sandbox',
      description: 'BM25 search in a response CATO stored (sbx_xxxxxxxx) or a raw command log (cmd_xxxxxxxx).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          query: { type: 'string' },
        },
        required: ['id', 'query'],
      },
    })
    if (hasAstGrep) {
      await $.tool.register({
        name: 'structural_search',
        description: 'ast-grep syntax-tree search (e.g. `console.log($A)`, `def $F($$$):`); compact `file:L<start>-L<end>` hits. Prefer to Grep for code patterns.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '$A one node, $$$ many' },
            lang: { type: 'string', description: 'ts, py, go...; optional' },
            path: { type: 'string', description: 'Inside the project; default all' },
            max_results: { type: 'number', description: 'Default 60' },
          },
          required: ['pattern'],
        },
      })
    }
    if (hasGraph) {
      await $.tool.register({
        name: 'graph_query',
        description: 'Queries the Graphify graph without loading it: matching nodes, file:line, community and neighbors.',
        inputSchema: {
          type: 'object',
          properties: {
            term: { type: 'string' },
            limit: { type: 'number', description: 'Default 12' },
          },
          required: ['term'],
        },
      })
    }
    await $.tool.register({
      name: 'cost_report',
      description: "CATO's recorded real cost: periods, cache misses by cause, tokens saved, advice.",
      inputSchema: { type: 'object', properties: { days: { type: 'number' } } },
    })
    await $.agent
      .register({
        name: 'cato-explorer',
        description: 'Broad codebase exploration (find symbols across files, trace dependencies) so raw reads stay out of the main context.',
        prompt: EXPLORER_PROMPT(hasGraph, hasAstGrep),
        tools: [
          'Read', 'Grep', 'Glob', 'mcp__cato__repo_map', 'mcp__cato__read_symbol',
          ...(hasAstGrep ? ['mcp__cato__structural_search'] : []),
          ...(hasGraph ? ['mcp__cato__graph_query'] : []),
        ],
        model: 'haiku',
        maxTurns: 18,
        omitClaudeMd: true,
      })
      .catch(() => undefined)
    await detectLanguage($)
    const c = t().commands
    await $.command.register({ name: 'cato', description: c.cato, argumentHint: c.catoHint })
    // O menu não mostra argumentos: cada subcomando também tem um comando próprio
    await $.command.register({ name: 'cato-doctor', description: c.doctor })
    await $.command.register({ name: 'cato-import', description: c.import })
    await $.command.register({ name: 'cato-experimental', description: c.experimental, argumentHint: c.experimentalHint })
    await cleanupOldFiles($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Só um número inteiro escrito muda o período; vazio ou qualquer outra coisa fica em 30 dias
  const days = (value: unknown): number => {
    const text = String(value ?? '').trim()
    return /^\d{1,3}$/.test(text) ? Math.max(1, Math.min(LEDGER_DAYS, Number(text))) : 30
  }

  // Largura do texto: a do terminal (o app informa), entre 60 e 110 colunas
  const columns = (e: { presentation?: { columns?: number } }): number => Math.max(60, Math.min(110, Number(e.presentation?.columns) || 100))

  on('command.run', { command: 'cato' }, async ($, e, next) => {
    await detectLanguage($)
    const arg = String(e.args ?? '').trim().toLowerCase()
    const width = columns(e)
    if (['import', 'importar'].includes(arg)) return { text: await importHistory($, () => next.budget.remainingMs, width) }
    if (arg === 'doctor') return { text: await doctor($, width) }
    const experimental = arg.match(/^experimenta(?:l|is|les)(?:\s+(.+))?$/)
    if (experimental) return { text: await toggleExperimental($, experimental[1] ?? '', width) }
    return { text: await costReport($, days(arg), width) }
  })

  on('command.run', { command: 'cato-doctor' }, async ($, e) => {
    await detectLanguage($)
    return { text: await doctor($, columns(e)) }
  })
  on('command.run', { command: 'cato-import' }, async ($, e, next) => {
    await detectLanguage($)
    return { text: await importHistory($, () => next.budget.remainingMs, columns(e)) }
  })
  on('command.run', { command: 'cato-experimental' }, async ($, e) => {
    await detectLanguage($)
    return { text: await toggleExperimental($, String(e.args ?? ''), columns(e)) }
  })

  on('tool.call', { tool: 'mcp__cato__cost_report' }, async ($, e) => {
    await detectLanguage($)
    return { result: await costReport($, days((e as unknown as { days?: number }).days)) }
  })

  on('tool.call', { tool: 'mcp__cato__repo_map' }, async ($, e) => {
    const input = e as unknown as { focus?: string; token_budget?: number }
    return { result: await repoMap($, input.focus, Number(input.token_budget) || 1200) }
  })

  on('tool.call', { tool: 'mcp__cato__structural_search' }, async ($, e) => {
    const input = e as unknown as { pattern: string; lang?: string; path?: string; max_results?: number }
    if (!String(input.pattern ?? '').trim()) return { deny: '[CATO] Provide a pattern.' }
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
    if (!/^(sbx|cmd)_[0-9a-f]{8}$/.test(id)) return { deny: `[CATO] Invalid ID: ${id} (expected sbx_xxxxxxxx or cmd_xxxxxxxx).` }
    try {
      return { result: await searchSandbox($, id, String(input.query)) }
    } catch {
      return { deny: `[CATO] ${id} not found (sandboxes and logs are deleted after ${RAW_FILE_DAYS} days).` }
    }
  })
}
