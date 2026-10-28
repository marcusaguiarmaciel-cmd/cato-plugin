// Integrações com Serena MCP, Graphify, ast-grep e GitHub MCP: funções puras, sem `$`.
//
// O CATO não substitui essas ferramentas: limita o que elas jogam no contexto (orçamento de resposta,
// JSON sem campos de API, leituras pesadas negadas) e usa o que elas produzem (o grafo do Graphify no
// repo_map, o ast-grep na busca estrutural).

import { compressGitDiff, estimateTokens } from './compress.ts'

export type Family = 'serena' | 'astgrep' | 'graphify' | 'github'

/** A qual integração uma ferramenta MCP pertence, pelo nome (`mcp__serena__find_symbol`, `mcp__plugin_x_github__...`). */
export function toolFamily(tool: string): Family | null {
  if (!tool.startsWith('mcp__')) return null
  const server = tool.slice(5, tool.indexOf('__', 5) > 0 ? tool.indexOf('__', 5) : undefined).toLowerCase()
  if (server.includes('serena')) return 'serena'
  if (/ast[-_]?grep/.test(server)) return 'astgrep'
  if (server.includes('graphify')) return 'graphify'
  if (server.includes('github')) return 'github'
  return null
}

/** Nome da ferramenta sem o prefixo do servidor (`mcp__serena__find_symbol` → `find_symbol`). */
export const toolBaseName = (tool: string): string => tool.slice(tool.lastIndexOf('__') + 2)

/** Caminho que uma chamada MCP vai ler, nos nomes de parâmetro que essas ferramentas usam. */
export function mcpTargetPath(input: Record<string, unknown>): string {
  for (const key of ['relative_path', 'path', 'file_path', 'project_folder']) {
    const value = input[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

// ---------------------------------------------------------------------------------------------------------
// Serena: ferramentas de leitura recebem um orçamento de resposta; as de escrita disparam checagem de sintaxe
// ---------------------------------------------------------------------------------------------------------

export const SERENA_READ_TOOLS = new Set([
  'find_symbol', 'get_symbols_overview', 'find_referencing_symbols', 'find_implementations', 'search_for_pattern',
  'read_file', 'list_dir', 'find_file', 'get_diagnostics_for_file', 'get_diagnostics_for_symbol',
])

export const SERENA_WRITE_TOOLS = new Set([
  'replace_symbol_body', 'insert_after_symbol', 'insert_before_symbol', 'rename_symbol', 'safe_delete_symbol',
  'replace_content', 'create_text_file', 'replace_lines', 'insert_at_line', 'delete_lines',
])

/** `max_answer_chars` ausente ou -1 (sem limite) recebe o orçamento do CATO; um limite que o modelo pediu fica. */
export function serenaBudget(input: Record<string, unknown>, budget: number): Record<string, unknown> | null {
  const current = Number(input.max_answer_chars)
  if (budget <= 0 || (Number.isFinite(current) && current > 0)) return null
  return { ...input, max_answer_chars: budget }
}

// ---------------------------------------------------------------------------------------------------------
// ast-grep: busca estrutural compacta (o JSON do CLI traz byteOffset, `lines` e metadados repetidos)
// ---------------------------------------------------------------------------------------------------------

type AstGrepMatch = {
  file?: string
  text?: string
  range?: { start?: { line?: number }; end?: { line?: number } }
  metaVariables?: { single?: Record<string, { text?: string }> }
}

function parseAstGrepJson(raw: string): AstGrepMatch[] | null {
  const text = raw.trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    // --json=stream: um objeto por linha
    const matches: AstGrepMatch[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        matches.push(JSON.parse(line))
      } catch {
        return null
      }
    }
    return matches
  }
}

/** Uma linha por casamento: `arquivo:L<início>-L<fim>  código` (linhas 1-based), com as metavariáveis. */
export function formatAstGrepMatches(raw: string, maxResults: number, budgetTokens = 6000): string | null {
  const matches = parseAstGrepJson(raw)
  if (!matches) return null
  if (!matches.length) return 'Nenhum casamento.'
  const out: string[] = []
  let used = 0
  let shown = 0
  for (const m of matches) {
    if (maxResults > 0 && shown >= maxResults) break
    const start = (m.range?.start?.line ?? 0) + 1
    const end = (m.range?.end?.line ?? start - 1) + 1
    const code = String(m.text ?? '').split('\n')
    const snippet = code.slice(0, 4).map(l => l.slice(0, 200)).join('\n    ') + (code.length > 4 ? `\n    ... (+${code.length - 4} linhas)` : '')
    const vars = Object.entries(m.metaVariables?.single ?? {})
      .map(([k, v]) => `$${k}=${String(v?.text ?? '').slice(0, 60)}`)
      .join(' ')
    const entry = `${m.file ?? '?'}:L${start}-L${end}${vars ? `  [${vars}]` : ''}\n    ${snippet}`
    const cost = estimateTokens(entry)
    if (used + cost > budgetTokens) break
    out.push(entry)
    used += cost
    shown += 1
  }
  const files = new Set(matches.map(m => m.file)).size
  const header = `${matches.length} casamento(s) em ${files} arquivo(s)` + (shown < matches.length ? `; mostrando ${shown}` : '')
  const footer = shown < matches.length ? `\n... [+${matches.length - shown} casamentos: refine o padrão ou passe path]` : ''
  return `${header}\n${out.join('\n')}${footer}`
}

// ---------------------------------------------------------------------------------------------------------
// GitHub MCP: JSON da API sem os campos que só servem a outros clientes da API
// ---------------------------------------------------------------------------------------------------------

const GITHUB_DROP_KEYS = new Set([
  'node_id', 'gravatar_id', '_links', 'performed_via_github_app', 'permissions', 'site_admin', 'user_view_type',
  'author_association', 'active_lock_reason', 'timeline_url', 'events_url', 'sub_issues_summary',
])

const isUser = (value: Record<string, unknown>) => typeof value.login === 'string' && ('avatar_url' in value || 'type' in value)

function stripGithub(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    // labels: só os nomes
    const isLabel = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && 'name' in v && 'color' in v
    if (value.length && value.every(isLabel)) return value.map(v => (v as { name: unknown }).name)
    return value.map(v => stripGithub(v, depth + 1))
  }
  const obj = value as Record<string, unknown>
  if (isUser(obj)) return obj.login
  const out: Record<string, unknown> = {}
  const hasHtml = typeof obj.html_url === 'string'
  for (const [key, v] of Object.entries(obj)) {
    if (v === null || GITHUB_DROP_KEYS.has(key)) continue
    if (key.endsWith('_url') && key !== 'html_url' && key !== 'download_url') continue
    if (key === 'url' && hasHtml) continue
    if (key === 'reactions' && v && typeof v === 'object') {
      const total = Number((v as { total_count?: unknown }).total_count) || 0
      if (total) out.reactions = total
      continue
    }
    out[key] = stripGithub(v, depth + 1)
  }
  return out
}

/** Compacta uma resposta do GitHub MCP: JSON sem campos de API e diffs sem lockfiles. Texto livre volta igual. */
export function compactGithubText(text: string): { text: string; changed: boolean } {
  const trimmed = text.trim()
  if (trimmed.startsWith('diff --git') || /^(From [0-9a-f]{40}|---\s.*\n\+\+\+\s)/m.test(trimmed.slice(0, 400))) {
    return compressGitDiff('git diff', text)
  }
  if (!/^[[{]/.test(trimmed)) return { text, changed: false }
  try {
    const compact = JSON.stringify(stripGithub(JSON.parse(trimmed)))
    return compact.length < trimmed.length * 0.9 ? { text: compact, changed: true } : { text, changed: false }
  } catch {
    return { text, changed: false }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Graphify: graphify-out/graph.json (networkx node-link: `nodes` e `links`)
// ---------------------------------------------------------------------------------------------------------

export type GraphNode = { id: string; label: string; file: string; location: string; community: string }
export type GraphLink = { source: string; target: string; relation: string; confidence: string }
export type Graph = { nodes: Map<string, GraphNode>; links: GraphLink[]; degree: Map<string, number> }

export const GRAPHIFY_JSON = 'graphify-out/graph.json'
export const GRAPHIFY_REPORT = 'graphify-out/GRAPH_REPORT.md'

const normPath = (p: string, root: string): string => {
  const path = p.replace(/\\/g, '/')
  const base = root.replace(/\\/g, '/').replace(/\/$/, '')
  return path.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? path.slice(base.length + 1) : path.replace(/^\.\//, '')
}

export function parseGraph(raw: string, root: string): Graph | null {
  let data: { nodes?: unknown[]; links?: unknown[]; edges?: unknown[] }
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(data.nodes)) return null
  const nodes = new Map<string, GraphNode>()
  for (const n of data.nodes as Record<string, unknown>[]) {
    const id = String(n.id ?? '')
    if (!id) continue
    nodes.set(id, {
      id,
      label: String(n.label ?? n.name ?? id),
      file: n.source_file ? normPath(String(n.source_file), root) : '',
      location: n.source_location ? String(n.source_location) : '',
      community: n.community === undefined || n.community === null ? '' : String(n.community),
    })
  }
  const links: GraphLink[] = []
  const degree = new Map<string, number>()
  for (const l of ((data.links ?? data.edges ?? []) as Record<string, unknown>[])) {
    const source = String(l.source ?? '')
    const target = String(l.target ?? '')
    if (!nodes.has(source) || !nodes.has(target)) continue
    links.push({ source, target, relation: String(l.relation ?? 'relates'), confidence: String(l.confidence ?? 'EXTRACTED') })
    degree.set(source, (degree.get(source) ?? 0) + 1)
    degree.set(target, (degree.get(target) ?? 0) + 1)
  }
  return { nodes, links, degree }
}

/** Arestas entre arquivos (peso pela confiança) para somar ao PageRank do repo_map. */
export function graphFileEdges(graph: Graph): Map<string, Map<string, number>> {
  const weight: Record<string, number> = { EXTRACTED: 1, INFERRED: 0.5, AMBIGUOUS: 0.2 }
  const edges = new Map<string, Map<string, number>>()
  for (const l of graph.links) {
    const a = graph.nodes.get(l.source)!.file
    const b = graph.nodes.get(l.target)!.file
    if (!a || !b || a === b) continue
    const out = edges.get(a) ?? new Map<string, number>()
    out.set(b, (out.get(b) ?? 0) + (weight[l.confidence] ?? 0.5) * 3)
    edges.set(a, out)
  }
  return edges
}

/** Nós que casam com o termo (por grau) e seus vizinhos, dentro do orçamento. */
export function queryGraph(graph: Graph, term: string, limit = 12, budgetTokens = 3000): string {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return 'Informe um termo.'
  const matched = [...graph.nodes.values()]
    .filter(n => words.every(w => `${n.label} ${n.id} ${n.file}`.toLowerCase().includes(w)))
    .sort((a, b) => (graph.degree.get(b.id) ?? 0) - (graph.degree.get(a.id) ?? 0))
  if (!matched.length) return `Nenhum nó do grafo casa com '${term}'.`
  const where = (n: GraphNode) => (n.file ? ` [${n.file}${n.location ? `:${n.location}` : ''}]` : '')
  const out: string[] = []
  let used = 0
  for (const node of matched.slice(0, limit)) {
    const lines = [`${node.label}${where(node)}${node.community ? ` (comunidade ${node.community})` : ''} — grau ${graph.degree.get(node.id) ?? 0}`]
    for (const l of graph.links) {
      if (lines.length > 15) {
        lines.push('  ...')
        break
      }
      const outgoing = l.source === node.id
      if (!outgoing && l.target !== node.id) continue
      const other = graph.nodes.get(outgoing ? l.target : l.source)!
      const tag = l.confidence === 'EXTRACTED' ? '' : ` {${l.confidence}}`
      lines.push(`  ${outgoing ? '→' : '←'} ${l.relation} ${other.label}${where(other)}${tag}`)
    }
    const block = lines.join('\n')
    const cost = estimateTokens(block)
    if (used + cost > budgetTokens) break
    out.push(block)
    used += cost
  }
  const extra = matched.length > out.length ? `\n... [+${matched.length - out.length} nós casam; refine o termo]` : ''
  return `# [CATO Graph: ${matched.length} nó(s) para '${term}' no grafo do Graphify]\n${out.join('\n\n')}${extra}`
}
