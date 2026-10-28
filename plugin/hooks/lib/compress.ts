// Compressão determinística de saídas de terminal (porte de bash_optimizer/parsers.py).
//
// Só comprime categorias reconhecidamente ruidosas (testes, linters/compiladores, instalações e builds,
// logs de container). Qualquer outra saída é dado e nunca tem linhas alteradas; só linhas EXATAMENTE
// iguais colapsam. Falhas, stack traces, números de linha e sumários finais são sempre preservados.

export const estimateTokens = (text: string): number => (text ? Math.max(1, Math.floor(text.length / 3.8)) : 0)

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
  return command.trim().replace(/^(cd\s+[^&;]+(&&|;)\s*)+/, '')
}

export function firstWord(command: string): string {
  const first = stripCdPrefix(command).split(/\s+/)[0] ?? ''
  return first.replace(/^["']|["']$/g, '').replace(/\\/g, '/').split('/').pop()!.toLowerCase()
}

export const isRtkCommand = (command: string): boolean => ['rtk', 'rtk.exe'].includes(firstWord(command))

/** `ast-grep ... --json` (ou `sg`): o JSON repete byteOffset, `lines` e metadados; vira uma linha por casamento. */
export const AST_GREP_JSON_RE = /(^|[\s;&|])(ast-grep|sg)(\.exe)?\s+(run|scan|-p|--pattern)\b[^\n]*--json/

/** Indica se vale a pena olhar a saída deste comando (filtro barato, antes de o comando rodar). */
export function isCompressibleCommand(command: string): boolean {
  if (isRtkCommand(command) || CODE_READ_COMMANDS.has(firstWord(command))) return false
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
    if (repeat > 0) out.push(`  ... [linha acima repetida, idêntica, mais ${repeat}x] ...`)
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

export function compressGeneric(text: string, maxLines = 120): { text: string; changed: boolean } {
  const raw = text.split('\n')
  const { lines, collapsed } = dedupeExactRepeats(raw)
  if (lines.length <= maxLines) return collapsed ? { text: lines.join('\n'), changed: true } : { text, changed: false }
  const head = lines.slice(0, 35)
  const tail = lines.slice(-45)
  const middle = lines.slice(35, -45)
  const errors: string[] = []
  middle.forEach((line, i) => {
    if (errors.length < 35 && ERROR_SIGNAL_RE.test(line)) errors.push(`L${i + 36}: ${line}`)
  })
  const out = [...head, `\n... [CATO: ${middle.length - errors.length} linhas intermediárias omitidas (de ${raw.length} totais)] ...`]
  if (errors.length) out.push('--- [CATO: linhas de erro/alerta do trecho omitido] ---', ...errors, '---')
  return { text: [...out, ...tail].join('\n'), changed: true }
}

export function compressTests(text: string): { text: string; changed: boolean } {
  const lines = text.split('\n')
  if (lines.length <= 35) return { text, changed: false }
  let passed = 0
  let omitted = 0
  let inFailure = false
  const kept: string[] = []
  for (const line of lines) {
    const s = line.trim()
    if (
      /^=+ (FAILURES|ERRORS) =+$/.test(s) || s.startsWith('FAIL ') || s.startsWith('failures:') ||
      s.startsWith('--- FAIL:') || s.includes('AssertionError') || s.includes('Traceback (most recent call last)')
    ) inFailure = true
    if (/^=+ (short test summary info|\d+ .* in [\d.]+s) =+$/.test(s)) inFailure = true
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
  if (omitted < 5) return { text, changed: false }
  const header = `[CATO Test Filter: ${passed} linhas de teste aprovado e ${omitted - passed} linhas de progresso/banner suprimidas]`
  const result = `${header}\n${kept.join('\n')}`
  return kept.length > 200 ? { text: compressGeneric(result, 180).text, changed: true } : { text: result, changed: true }
}

export function compressLinter(text: string): { text: string; changed: boolean } {
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length <= 50) return { text, changed: false }
  const counts = new Map<string, number>()
  const kept: string[] = []
  let suppressed = 0
  for (const line of lines) {
    const m = line.match(/\b(TS\d{4}|[EFW]\d{3,4})\b|(\[[\w\-/@]+\])/)
    if (m) {
      const code = m[1] ?? m[2]
      const n = (counts.get(code) ?? 0) + 1
      counts.set(code, n)
      if (n > 10) { suppressed += 1; continue }
    }
    if (kept.length < 120) kept.push(line)
    else suppressed += 1
  }
  if (!suppressed) return { text, changed: false }
  const dist = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => `${c}: ${n}x`).join(', ')
  return {
    text: `${kept.join('\n')}\n[CATO Linter Filter: ${suppressed} linhas adicionais suprimidas${dist ? ` | Distribuição por código: ${dist}` : ''}]`,
    changed: true,
  }
}

export function compressGitDiff(command: string, text: string): { text: string; changed: boolean } {
  const lines = text.split('\n')
  if (lines.length <= 80 || !/\bgit\s+(diff|show)\b/.test(command)) return { text, changed: false }
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
  if (!omitted) return { text, changed: false }
  kept.push(`\n[CATO Git Diff Filter: ${omitted} linhas de lockfiles/bundles omitidas]`)
  return { text: kept.join('\n'), changed: true }
}

/** Ponto de entrada: `{ text, changed, strategy }`. Saídas que não são de uma categoria ruidosa voltam iguais. */
export function optimizeOutput(command: string, raw: string): { text: string; changed: boolean; strategy: string } {
  if (!raw) return { text: '', changed: false, strategy: 'empty' }
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
    return r.changed || ansiRemoved ? { ...r, changed: true, strategy: 'git_parser' } : { text: cleaned, changed: false, strategy: 'passthrough' }
  }
  if (NOISY_RE.test(cmd)) {
    const r = compressGeneric(cleaned, 120)
    if (r.changed || ansiRemoved) return { ...r, changed: true, strategy: 'build_log_compressor' }
  }
  return ansiRemoved ? { text: cleaned, changed: true, strategy: 'ansi_strip' } : { text: cleaned, changed: false, strategy: 'passthrough' }
}
