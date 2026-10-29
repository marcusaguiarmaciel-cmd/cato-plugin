// Compressão determinística de saídas de terminal (porte de bash_optimizer/parsers.py).
//
// Só comprime categorias reconhecidamente ruidosas (testes, linters/compiladores, instalações e builds,
// logs de container). Qualquer outra saída é dado e nunca tem linhas alteradas; só linhas EXATAMENTE
// iguais colapsam. Falhas, stack traces, números de linha e sumários finais têm prioridade; quando passam
// do limite, `omittedErrors` diz quantas linhas de erro ficaram de fora (todas estão no log bruto).

/** Estimativa (caracteres ÷ 3,8), não contagem do tokenizador: serve para comparar antes e depois. */
export const estimateTokens = (text: string): number => (text ? Math.max(1, Math.floor(text.length / 3.8)) : 0)

export type Compressed = { text: string; changed: boolean; omittedErrors: number }

const isErrorLine = (line: string): boolean => ERROR_SIGNAL_RE.test(line)

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
const PROGRESS_BAR_RE = /^[\s█▓▒░#=>\-\[\]|]*[█▓▒░][\s█▓▒░#=>\-\[\]|]*(\d{1,3}(\.\d+)?%)?.{0,40}$/
export const ERROR_SIGNAL_RE =
  /\b(error|exception|traceback|failed|failure|fatal|panic|assert|syntaxerror|typeerror|referenceerror|undefined|cannot find)\b/i

const TEST_RE = /\b(pytest|py\.test|unittest|jest|vitest|mocha|cargo test|go test|npm (run )?test|pnpm test|yarn test)\b/i
const LINTER_RE = /\b(tsc|eslint|ruff|flake8|mypy|pyright|clippy|cargo check|biome)\b/i
const NOISY_RE = new RegExp(
  [
    'pip3?\\s+install', 'python -m pip install', 'uv\\s+(pip|sync|add)', 'poetry\\s+(install|add|update)',
    'npm\\s+(install|ci|i|run\\s+build)', 'pnpm\\s+(install|i|add|build)', 'yarn(\\s+(install|add|build))?$',
    'cargo\\s+build', 'go\\s+(build|mod\\s+download)', 'docker(-compose)?\\s+(compose\\s+)?(build|pull|logs)',
    'kubectl\\s+logs', '\\bmake\\b', '\\bcmake\\b', 'gradle', '\\bmvn\\b', 'webpack', 'vite\\s+build',
    'next\\s+build', 'apt(-get)?\\s+install', 'brew\\s+install', 'choco\\s+install', 'winget\\s+install',
  ].join('|'),
  'i',
)

// Comandos cuja saída é conteúdo que o modelo pediu para ler: nunca comprimir
const CODE_READ_COMMANDS = new Set([
  'sed', 'cat', 'head', 'tail', 'less', 'more', 'nl', 'awk', 'grep', 'egrep', 'rg', 'bat', 'jq',
  'get-content', 'gc', 'type', 'select-string',
])

const LOCKFILES = [
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'poetry.lock', 'uv.lock', '.min.js', '.min.css',
]

export function stripCdPrefix(command: string): string {
  return command.trim().replace(/^((?:cd|pushd|set-location|sl|echo|export|set)\s+[^&;|]+(&&|;)\s*)+/i, '')
}

export function firstWord(command: string): string {
  const first = stripCdPrefix(command).split(/\s+/)[0] ?? ''
  return first.replace(/^["']|["']$/g, '').replace(/\\/g, '/').split('/').pop()!.toLowerCase()
}

export const isRtkCommand = (command: string): boolean => ['rtk', 'rtk.exe'].includes(firstWord(command))

/** `ast-grep ... --json` (ou `sg`): o JSON repete byteOffset, `lines` e metadados; vira uma linha por casamento. */
export const AST_GREP_JSON_RE = /(^|[\s;&|])(ast-grep|sg)(\.exe)?\s+(run|scan|-p|--pattern)\b[^\n]*--json/

// Quando o próprio comando já termina filtrando a saída por pipe, o CATO não recomprime por cima
const FILTER_PIPE_RE = /\|\s*(?:grep|egrep|fgrep|rg|head|tail|awk|sed|jq|wc|cut|sort|uniq|select-string|select-object)\b[^|]*$/i

/** Indica se vale a pena olhar a saída deste comando (filtro barato, antes de o comando rodar). */
export function isCompressibleCommand(command: string): boolean {
  if (isRtkCommand(command) || CODE_READ_COMMANDS.has(firstWord(command)) || FILTER_PIPE_RE.test(command)) return false
  const cmd = stripCdPrefix(command)
  return TEST_RE.test(cmd) || LINTER_RE.test(cmd) || NOISY_RE.test(cmd) || /\bgit\s+(diff|show)\b/.test(cmd) || AST_GREP_JSON_RE.test(cmd)
}

export function stripAnsiAndProgress(text: string): string {
  if (!text) return ''
  const lines: string[] = []
  for (let raw of text.replace(ANSI_RE, '').replace(/\r\n/g, '\n').split('\n')) {
    if (raw.includes('\r')) {
      const segments = raw.split('\r').filter(s => s.trim())
      raw = segments.length ? segments[segments.length - 1] : ''
    }
    const stripped = raw.trim()
    if (stripped && PROGRESS_BAR_RE.test(stripped)) continue
    lines.push(raw.trimEnd())
  }
  return lines.join('\n')
}

export function dedupeExactRepeats(lines: string[]): { lines: string[]; collapsed: number } {
  const out: string[] = []
  let prev: string | null = null
  let repeat = 0
  let collapsed = 0
  const flush = () => {
    if (repeat > 0) out.push(`  ... [line above repeated identically ${repeat} more times] ...`)
    repeat = 0
  }
  for (const line of lines) {
    const t = line.trim()
    if (t && t === prev && t.length > 10) {
      repeat += 1
      collapsed += 1
    } else {
      flush()
      out.push(line)
      prev = t
    }
  }
  flush()
  return { lines: out, collapsed }
}

const MAX_DISTINCT_ERRORS = 150

export function compressGeneric(text: string, maxLines = 120): Compressed {
  const raw = text.split('\n')
  const { lines, collapsed } = dedupeExactRepeats(raw)
  if (lines.length <= maxLines) {
    return collapsed ? { text: lines.join('\n'), changed: true, omittedErrors: 0 } : { text, changed: false, omittedErrors: 0 }
  }
  const head = lines.slice(0, 35)
  const tail = lines.slice(-45)
  const middle = lines.slice(35, -45)
  // Linhas de erro do meio: cada texto distinto uma vez (com quantas vezes apareceu), até o limite
  const errors = new Map<string, { line: number; count: number }>()
  let omittedErrors = 0
  middle.forEach((line, i) => {
    if (!isErrorLine(line)) return
    const key = line.trim()
    const seen = errors.get(key)
    if (seen) seen.count += 1
    else if (errors.size < MAX_DISTINCT_ERRORS) errors.set(key, { line: i + 36, count: 1 })
    else omittedErrors += 1
  })
  const errorLines = [...errors].map(([line, at]) => `L${at.line}: ${line}${at.count > 1 ? `  [${at.count}x]` : ''}`)
  const kept = [...errors.values()].reduce((sum, at) => sum + at.count, 0)
  const out = [...head, `\n... [CATO: ${middle.length - kept} middle lines omitted (of ${raw.length} total)] ...`]
  if (errorLines.length) out.push('--- [CATO: error/warning lines from the omitted part] ---', ...errorLines, '---')
  return { text: [...out, ...tail].join('\n'), changed: true, omittedErrors }
}

const FAILURE_START_RE = /^=+ (FAILURES|ERRORS) =+$|^FAIL |^failures:|^--- FAIL:|AssertionError|Traceback \(most recent call last\)/
const MAX_FAILURE_LINES = 400

/** Saída de teste longa demais mesmo sem os aprovados: o trecho de falhas fica inteiro até o limite, e o fim (sumário) sempre. */
function trimTestOutput(kept: string[], failureStart: number): Compressed {
  const before = failureStart < 0 ? kept : kept.slice(0, failureStart)
  const failures = failureStart < 0 ? [] : kept.slice(failureStart)
  const out: string[] = []
  let omittedErrors = 0

  // Antes das falhas: o começo e qualquer linha de erro solta
  const beforeKept = before.slice(0, 40)
  const beforeRest = before.slice(40)
  const looseErrors = beforeRest.filter(isErrorLine)
  out.push(...beforeKept)
  if (beforeRest.length) {
    out.push(`... [CATO: ${beforeRest.length - Math.min(looseErrors.length, 60)} lines before the failures omitted] ...`)
    out.push(...looseErrors.slice(0, 60))
    omittedErrors += Math.max(0, looseErrors.length - 60)
  }

  if (failures.length <= MAX_FAILURE_LINES) {
    out.push(...failures)
  } else {
    const head = failures.slice(0, MAX_FAILURE_LINES - 60)
    const tail = failures.slice(-60) // sumário final do runner
    const middle = failures.slice(MAX_FAILURE_LINES - 60, -60)
    omittedErrors += middle.filter(line => isErrorLine(line) || FAILURE_START_RE.test(line.trim())).length
    out.push(...head, `... [CATO: ${middle.length} lines from the failures section omitted] ...`, ...tail)
  }
  return { text: out.join('\n'), changed: true, omittedErrors }
}

export function compressTests(text: string): Compressed {
  const lines = text.split('\n')
  if (lines.length <= 35) return { text, changed: false, omittedErrors: 0 }
  let passed = 0
  let omitted = 0
  let inFailure = false
  let failureStart = -1
  const kept: string[] = []
  for (const line of lines) {
    const s = line.trim()
    if (!inFailure && (FAILURE_START_RE.test(s) || /^=+ (short test summary info|\d+ .* in [\d.]+s) =+$/.test(s))) {
      inFailure = true
      failureStart = kept.length
    }
    if (!inFailure) {
      if (
        /::.*?\s+PASSED(?:\s+\[\s*\d+%\])?$/.test(s) || /^(✓|✔|PASS)\s+/.test(s) ||
        /^\S+\s+\(\S+\)\s+\.\.\.\s+ok$/.test(s) || /^test\s+\S+\s+\.\.\.\s+ok$/.test(s) || /^ok\s+\S+\s+[\d.]+s$/.test(s)
      ) { passed += 1; omitted += 1; continue }
      if (/^[.s]+(\s+\[\s*\d+%\])?$/.test(s)) { omitted += 1; continue }
      if (['platform ', 'cachedir:', 'rootdir:', 'plugins:', 'collecting ...'].some(p => s.startsWith(p))) {
        omitted += 1
        continue
      }
    }
    kept.push(line)
  }
  // Quase nada para suprimir e saída curta: fica como está. Longa, o corte por seção ainda vale.
  if (omitted < 5 && kept.length <= 200) return { text, changed: false, omittedErrors: 0 }
  const header = `[CATO Test Filter: ${passed} passing-test lines and ${omitted - passed} progress/banner lines suppressed]`
  if (kept.length <= 200) return { text: `${header}\n${kept.join('\n')}`, changed: true, omittedErrors: 0 }
  const trimmed = trimTestOutput(kept, failureStart)
  return { ...trimmed, text: `${header}\n${trimmed.text}` }
}

const LINT_CODE_RE = /\b(TS\d{4}|[EFW]\d{3,4})\b|(\[[\w\-/@]+\])/
// `src/a.ts(10,5): error ...` e `src/a.py:10:5: E501 ...`
const LINT_FILE_RE = /^\s*([^\s:(]+\.[A-Za-z0-9]+)[:(]/
// Cabeçalho de arquivo do eslint/biome: uma linha só com o caminho
const LINT_HEADER_RE = /^\s*(\S+\.[A-Za-z0-9]+)\s*$/
const MAX_LINT_LINES = 300

export function compressLinter(text: string): Compressed {
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length <= 50) return { text, changed: false, omittedErrors: 0 }
  const counts = new Map<string, number>()
  const perFile = new Map<string, number>()
  const firstPerFile = new Set<string>()
  const kept: string[] = []
  let currentFile = ''
  let suppressed = 0
  let omittedErrors = 0
  for (const line of lines) {
    const header = line.match(LINT_HEADER_RE)
    if (header && !LINT_CODE_RE.test(line)) currentFile = header[1]
    const file = line.match(LINT_FILE_RE)?.[1] ?? currentFile
    const m = line.match(LINT_CODE_RE)
    let isFirst = false
    if (m) {
      const code = m[1] ?? m[2]
      counts.set(code, (counts.get(code) ?? 0) + 1)
      if (file) perFile.set(file, (perFile.get(file) ?? 0) + 1)
      // A primeira ocorrência de cada (arquivo, código) sempre aparece; as repetições, até 10 por código
      const key = `${file}|${code}`
      isFirst = !firstPerFile.has(key)
      firstPerFile.add(key)
      if (!isFirst && (counts.get(code) ?? 0) > 10) {
        suppressed += 1
        omittedErrors += 1
        continue
      }
    }
    if (kept.length < MAX_LINT_LINES) {
      kept.push(line)
    } else {
      suppressed += 1
      if (m || isErrorLine(line)) omittedErrors += 1
    }
  }
  if (!suppressed) return { text, changed: false, omittedErrors: 0 }
  const dist = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => `${c}: ${n}x`).join(', ')
  const files = [...perFile].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([f, n]) => `${f}: ${n}`).join(', ')
  return {
    text:
      `${kept.join('\n')}\n[CATO Linter Filter: ${suppressed} more lines suppressed` +
      `${dist ? ` | By code: ${dist}` : ''}${files ? ` | By file: ${files}` : ''}]`,
    changed: true,
    omittedErrors,
  }
}

export function compressGitDiff(command: string, text: string): Compressed {
  const lines = text.split('\n')
  if (lines.length <= 80 || !/\bgit\s+(diff|show)\b/.test(command)) return { text, changed: false, omittedErrors: 0 }
  const kept: string[] = []
  let skip = false
  let omitted = 0
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      skip = LOCKFILES.some(lock => line.includes(lock))
      if (skip) {
        kept.push(line, '  [CATO: Diff de lockfile/bundle minificado omitido para economizar tokens]')
        continue
      }
    }
    if (skip) { omitted += 1; continue }
    kept.push(line)
  }
  if (!omitted) return { text, changed: false, omittedErrors: 0 }
  kept.push(`\n[CATO Git Diff Filter: ${omitted} lockfile/bundle lines omitted]`)
  return { text: kept.join('\n'), changed: true, omittedErrors: 0 }
}

export type Optimized = Compressed & { strategy: string }

/** Ponto de entrada: `{ text, changed, strategy, omittedErrors }`. Saídas que não são de uma categoria ruidosa voltam iguais. */
export function optimizeOutput(command: string, raw: string): Optimized {
  if (!raw) return { text: '', changed: false, strategy: 'empty', omittedErrors: 0 }
  const cleaned = stripAnsiAndProgress(raw)
  const ansiRemoved = cleaned.length < raw.length - 20
  const cmd = stripCdPrefix(command)
  if (TEST_RE.test(cmd)) {
    const r = compressTests(cleaned)
    if (r.changed || ansiRemoved) return { ...r, changed: true, strategy: 'test_suite_parser' }
  }
  if (LINTER_RE.test(cmd)) {
    const r = compressLinter(cleaned)
    if (r.changed || ansiRemoved) return { ...r, changed: true, strategy: 'linter_compiler_parser' }
  }
  if (/^git\s|\sgit\s/.test(cmd)) {
    const r = compressGitDiff(cmd, cleaned)
    return r.changed || ansiRemoved
      ? { ...r, changed: true, strategy: 'git_parser' }
      : { text: cleaned, changed: false, strategy: 'passthrough', omittedErrors: 0 }
  }
  if (NOISY_RE.test(cmd)) {
    const r = compressGeneric(cleaned, 120)
    if (r.changed || ansiRemoved) return { ...r, changed: true, strategy: 'build_log_compressor' }
  }
  return ansiRemoved
    ? { text: cleaned, changed: true, strategy: 'ansi_strip', omittedErrors: 0 }
    : { text: cleaned, changed: false, strategy: 'passthrough', omittedErrors: 0 }
}
