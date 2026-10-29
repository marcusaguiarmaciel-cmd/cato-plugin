import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { bullet, formatter, langFrom, table, wrap } from '../hooks/lib/format.ts'
import { MESSAGES } from '../hooks/lib/messages.ts'

const CMD = (command: string, args = '', columns = 100) => ({ command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns } })
const norm = (p: unknown) => String(p).replace(/\\/g, '/')

/** Projeto vazio; `settings` são os settings.json do Claude Code por caminho. */
function world(on: On, settings: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  mock.store(on)
  mock.clock(on, { now: Date.UTC(2026, 9, 28, 15) })
  mock.env(on, { USERPROFILE: 'C:\\Users\\t', ...env })
  on('session.cwd', () => ({ value: 'C:/proj' }))
  on('fs.read', (_, e) => (norm(e.path) in settings ? { value: JSON.stringify(settings[norm(e.path)]) } : { deny: 'missing' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
}

const run = async ($: { command: { run: (i: ReturnType<typeof CMD>) => Promise<unknown> } }, command: string, args = '', columns = 100) =>
  String(((await $.command.run(CMD(command, args, columns))) as { text?: string }).text)

test('langFrom: locales, nomes livres do Claude Code e valores sem suporte', () => {
  expect(langFrom('pt-BR')).toBe('pt')
  expect(langFrom('pt_BR.UTF-8')).toBe('pt')
  expect(langFrom('portuguese')).toBe('pt')
  expect(langFrom('Português')).toBe('pt')
  expect(langFrom('es_ES')).toBe('es')
  expect(langFrom('spanish')).toBe('es')
  expect(langFrom('Español')).toBe('es')
  expect(langFrom('en-US')).toBe('en')
  expect(langFrom('english')).toBe('en')
  expect(langFrom('japanese')).toBeNull()
  expect(langFrom('auto')).toBeNull()
  expect(langFrom('C.UTF-8')).toBeNull()
  expect(langFrom('')).toBeNull()
})

test('formatter: dinheiro, tokens e datas no padrão de cada idioma', () => {
  const en = formatter('en')
  const pt = formatter('pt')
  expect(en.money(1234.5)).toBe('$1,234.50')
  expect(pt.money(1234.5)).toBe('US$ 1.234,50')
  expect(en.tokens(369_300_000)).toBe('369.3M')
  expect(pt.tokens(739_000)).toBe('739 mil')
  expect(en.int(8318)).toBe('8,318')
  expect(pt.int(8318)).toBe('8.318')
  expect(en.date('2026-07-01')).toBe('Jul 1, 2026')
  expect(en.pct(0.66)).toBe('66%')
})

test('table, wrap e bullet: colunas alinhadas e quebra na largura', () => {
  const lines = table([['Cause', 'Cost'], ['Idle', '$3.84'], ['Model switch', '$120.00']], [false, true])
  expect(lines).toEqual([
    '  Cause             Cost',
    '  ────────────   ───────',
    '  Idle             $3.84',
    '  Model switch   $120.00',
  ])
  expect(wrap('one two three four five six seven eight nine ten eleven twelve thirteen', 40).every(l => l.length <= 40)).toBe(true)
  const b = bullet('•', 'a '.repeat(60).trim(), 60)
  expect(b[0].startsWith('  • a')).toBe(true)
  expect(b[1].startsWith('    a')).toBe(true)
})

test('os três idiomas têm as mesmas chaves', () => {
  const shape = (value: unknown): unknown =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]))
      : Array.isArray(value) ? value.length : typeof value
  expect(shape(MESSAGES.pt)).toEqual(shape(MESSAGES.en))
  expect(shape(MESSAGES.es)).toEqual(shape(MESSAGES.en))
})

test('opção language=en: relatório em inglês, com tabela e dica de período', { options: { language: 'en' } }, async ($, on) => {
  world(on)
  const text = await run($, 'cato')
  expect(text).toContain('CATO · Real cost — last 30 days')
  expect(text).toMatch(/Period\s+Cost\s+Calls\s+Tokens/)
  expect(text).toMatch(/today\s+\$0\.00\s+0/)
  expect(text).toContain('▸ Cache misses — main conversation')
  expect(text).toContain('No interventions in this period.')
  expect(text).toContain('Another period: /cato <days> (1–90).')
})

test('language do Claude Code ("spanish") vale quando a opção é auto', { options: { language: 'auto' } }, async ($, on) => {
  world(on, { 'C:/Users/t/.claude/settings.json': { language: 'spanish' } })
  expect(await run($, 'cato')).toContain('CATO · Costo real — últimos 30 días')
  expect(await run($, 'cato-doctor')).toContain("Idioma: Español (ajuste `language` de Claude Code).")
})

test('settings do projeto vencem as do usuário; idioma sem suporte cai no inglês', { options: { language: 'auto' } }, async ($, on) => {
  world(on, {
    'C:/Users/t/.claude/settings.json': { language: 'spanish' },
    'C:/proj/.claude/settings.json': { language: 'japanese' },
  })
  expect(await run($, 'cato-doctor')).toContain("Language: English (Claude Code `language` setting).")
})

test('sem configuração, o idioma do sistema decide', { options: { language: 'auto' } }, async ($, on) => {
  world(on, {}, { LANG: 'pt_BR.UTF-8' })
  const text = await run($, 'cato-doctor')
  expect(text).toContain('CATO · Diagnóstico')
  expect(text).toContain('Idioma: Português (idioma do sistema).')
})

test('/cato-experimental aceita palavras dos três idiomas', { options: { language: 'es' } }, async ($, on) => {
  world(on)
  expect(await run($, 'cato-experimental', 'activar')).toContain('readGuard activado · maskColdCompact activado (elegido con /cato-experimental)')
  expect(await run($, 'cato-experimental', 'off')).toContain('readGuard desactivado · maskColdCompact desactivado')
  expect(await run($, 'cato-experimental', 'padrão')).toContain('(configuración de /plugin)')
})

test('texto quebra na largura que o app informa', { options: { language: 'en' } }, async ($, on) => {
  world(on)
  const text = await run($, 'cato-doctor', '', 60)
  expect(text.split('\n').every(line => [...line].length <= 62)).toBe(true)
})
