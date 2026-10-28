// Inteligência de código sem Python (porte de code_intel/*.py): declarações, esqueleto com linhas,
// extração cirúrgica de símbolo e mapa do repositório ranqueado por Personalized PageRank.

import { estimateTokens } from './compress.ts'

export const CODE_EXTENSIONS = new Set([
  '.py', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.go', '.rs', '.java', '.kt', '.cs',
  '.cpp', '.cc', '.c', '.h', '.hpp', '.rb', '.php', '.swift', '.scala', '.vue', '.svelte',
])

export const IGNORED_DIRS = new Set([
  '.git', '.claude', '.cato', 'node_modules', 'dist', 'build', 'coverage', '.next', 'target', '__pycache__',
  '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', 'graphify-out', '.serena',
])

export const isCodeFile = (path: string): boolean => {
  const dot = path.lastIndexOf('.')
  return dot >= 0 && CODE_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

// Cada padrão captura no grupo 1 o NOME declarado; uma linha que só usa o nome nunca casa
const DECLARATIONS: RegExp[] = [
  /^\s*(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/, // Python
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|interface|type|enum|function\*?)\s+([A-Za-z0-9_$]+)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/,
  /^\s*(?:public|private|protected|static|readonly|async|override|virtual|internal)+\s+(?:[A-Za-z0-9_<>[\],\s]+\s+)?([A-Za-z0-9_$]+)\s*\(/,
  /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|impl|mod|type)\s+([A-Za-z0-9_]+)/, // Rust
  /^\s*(?:func|type)\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_]+)/, // Go
  // Método TS/JS sem modificador (`  getUser(id) {`), sem confundir com if/for/while
  /^\s+(?:async\s+)?(?!(?:if|for|while|switch|catch|function|return)\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/,
]

export function declaredName(line: string): string | null {
  for (const re of DECLARATIONS) {
    const m = line.match(re)
    if (m) return m[1]
  }
  return null
}

const isPython = (path: string) => path.toLowerCase().endsWith('.py')

/** Fim do bloco que começa na linha `idx`: chaves balanceadas, ou indentação em Python. */
function blockEnd(lines: string[], idx: number, python: boolean): number {
  if (python) {
    const indent = lines[idx].match(/^\s*/)![0].length
    let end = idx
    for (let j = idx + 1; j < lines.length; j++) {
      const l = lines[j]
      if (!l.trim()) continue
      if (l.match(/^\s*/)![0].length <= indent && !l.trim().startsWith('@')) break
      end = j
    }
    return end
  }
  let balance = (lines[idx].match(/\{/g) ?? []).length - (lines[idx].match(/\}/g) ?? []).length
  if (!lines[idx].includes('{') || balance <= 0) {
    // Assinatura que abre a chave numa linha seguinte
    for (let j = idx + 1; j < Math.min(lines.length, idx + 5); j++) {
      if (lines[j].includes('{')) {
        balance = 0
        for (let k = idx; k < lines.length; k++) {
          balance += (lines[k].match(/\{/g) ?? []).length - (lines[k].match(/\}/g) ?? []).length
          if (k >= j && balance <= 0) return k
        }
        return lines.length - 1
      }
    }
    return Math.min(lines.length - 1, idx + 45)
  }
  for (let j = idx + 1; j < lines.length; j++) {
    balance += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length
    if (balance <= 0) return j
  }
  return lines.length - 1
}

const numbered = (lines: string[], start: number, end: number): string =>
  lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n')

/**
 * Extrai a definição de `symbol` (`Classe`, `funcao` ou `Classe.metodo`) com números de linha.
 * Só linhas que DECLARAM o nome contam; com `Pai.filho`, procura o filho dentro do bloco do pai.
 */
export function extractSymbol(path: string, source: string, symbol: string): { text: string; start: number; end: number } | null {
  const lines = source.split(/\r?\n/)
  const parts = symbol.split('.').map(p => p.trim()).filter(Boolean)
  const target = parts[parts.length - 1] ?? symbol.trim()
  const parent = parts.length > 1 ? parts[0] : null
  const python = isPython(path)
  let from = 0
  let to = lines.length - 1
  if (parent) {
    const p = lines.findIndex(l => declaredName(l) === parent)
    if (p < 0) return null
    from = p + 1
    to = blockEnd(lines, p, python)
  }
  for (let i = from; i <= to; i++) {
    if (declaredName(lines[i]) !== target) continue
    let start = i
    while (python && start > 0 && lines[start - 1].trim().startsWith('@')) start -= 1 // decoradores
    const end = blockEnd(lines, i, python)
    return { text: numbered(lines, start + 1, end + 1), start: start + 1, end: end + 1 }
  }
  return null
}

/** Esqueleto: só as linhas de declaração, cada uma com o intervalo `[L<início>-L<fim>]` do seu bloco. */
export function skeleton(path: string, source: string, maxLines = 80): string {
  const lines = source.split(/\r?\n/)
  const python = isPython(path)
  const out: string[] = []
  lines.forEach((line, i) => {
    if (out.length >= maxLines || !declaredName(line)) return
    out.push(`  [L${i + 1}-L${blockEnd(lines, i, python) + 1}] ${line.trim().slice(0, 140)}`)
  })
  return out.join('\n')
}

function pagerank(nodes: string[], edges: Map<string, Map<string, number>>, personal: Map<string, number>, iterations = 18, alpha = 0.85) {
  const n = nodes.length
  const total = [...personal.values()].reduce((a, b) => a + b, 0)
  const pers = new Map(nodes.map(k => [k, total > 0 ? (personal.get(k) ?? 0) / total : 1 / n]))
  let ranks = new Map(pers)
  for (let it = 0; it < iterations; it++) {
    const next = new Map(nodes.map(k => [k, (1 - alpha) * pers.get(k)!]))
    let dangling = 0
    for (const u of nodes) {
      const out = edges.get(u)
      const w = out ? [...out.values()].reduce((a, b) => a + b, 0) : 0
      if (w > 0) for (const [v, weight] of out!) next.set(v, next.get(v)! + alpha * ranks.get(u)! * (weight / w))
      else dangling += ranks.get(u)!
    }
    if (dangling > 0) for (const k of nodes) next.set(k, next.get(k)! + alpha * dangling * pers.get(k)!)
    ranks = next
  }
  return ranks
}

/**
 * Mapa do repositório no estilo Aider: arquivos mais centrais primeiro, cada um com seu esqueleto, dentro do orçamento.
 * `extraEdges` soma relações vindas de fora (o grafo do Graphify) às inferidas pelos símbolos.
 */
export function buildRepoMap(
  files: Map<string, string>,
  focus: string | undefined,
  budgetTokens: number,
  extraEdges?: Map<string, Map<string, number>>,
): string {
  const names = [...files.keys()]
  if (!names.length) return '# [CATO RepoMap] Nenhum arquivo de código encontrado.'
  const defs = new Map<string, Set<string>>()
  const words = new Map<string, Set<string>>()
  const definers = new Map<string, string[]>()
  for (const [name, src] of files) {
    const d = new Set<string>()
    for (const line of src.split(/\r?\n/)) {
      const id = declaredName(line)
      if (id && id.length >= 3) d.add(id)
    }
    defs.set(name, d)
    words.set(name, new Set(src.match(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g) ?? []))
    for (const id of d) definers.set(id, [...(definers.get(id) ?? []), name])
  }
  const edges = new Map<string, Map<string, number>>()
  for (const [name, ws] of words) {
    const out = new Map<string, number>()
    for (const w of ws) for (const def of definers.get(w) ?? []) if (def !== name) out.set(def, (out.get(def) ?? 0) + 1)
    edges.set(name, out)
  }
  for (const [from, targets] of extraEdges ?? []) {
    const out = edges.get(from)
    if (!out) continue
    for (const [to, weight] of targets) if (files.has(to) && to !== from) out.set(to, (out.get(to) ?? 0) + weight)
  }
  const personal = new Map<string, number>()
  const terms = (focus ?? '').toLowerCase().split(/[^a-z0-9_./-]+/).filter(t => t.length >= 2)
  for (const name of names) {
    let score = 0
    for (const t of terms) {
      if (name.toLowerCase().includes(t)) score += 5
      for (const d of defs.get(name)!) if (d.toLowerCase().includes(t)) score += 1
    }
    if (score) personal.set(name, score)
  }
  const ranks = pagerank(names, edges, personal)
  const ordered = names.sort((a, b) => ranks.get(b)! - ranks.get(a)!)
  const sections: string[] = []
  let used = 0
  for (const name of ordered) {
    const body = skeleton(name, files.get(name)!, 40)
    if (!body) continue
    const section = `${name}:\n${body}`
    const cost = estimateTokens(section)
    if (used + cost > budgetTokens) continue
    sections.push(section)
    used += cost
  }
  return [`# [CATO RepoMap] ${sections.length} de ${names.length} arquivos (≈${used} tokens), mais centrais primeiro`, ...sections].join('\n\n')
}

// ---------------------------------------------------------------------------
// Sandbox de respostas MCP grandes: blocos de 20 linhas e busca BM25 simples
// ---------------------------------------------------------------------------

export type SandboxChunk = { title: string; content: string }

export function chunkLines(text: string, size = 20): SandboxChunk[] {
  const lines = text.split('\n')
  const chunks: SandboxChunk[] = []
  for (let i = 0; i < lines.length; i += size) {
    chunks.push({ title: `Linhas ${i + 1}-${Math.min(lines.length, i + size)}`, content: lines.slice(i, i + size).join('\n') })
  }
  return chunks
}

const tokenize = (s: string): string[] => (s.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])

export function bm25Search(chunks: SandboxChunk[], query: string, limit = 5): SandboxChunk[] {
  const terms = tokenize(query)
  if (!terms.length) return []
  const docs = chunks.map(c => tokenize(`${c.title} ${c.content}`))
  const avg = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length)
  const df = new Map(terms.map(t => [t, docs.filter(d => d.includes(t)).length]))
  const scored = docs.map((doc, i) => {
    let score = 0
    for (const t of terms) {
      const tf = doc.filter(w => w === t).length
      if (!tf) continue
      const idf = Math.log(1 + (docs.length - df.get(t)! + 0.5) / (df.get(t)! + 0.5))
      score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (doc.length / avg)))
    }
    return { i, score }
  })
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(s => chunks[s.i])
}
