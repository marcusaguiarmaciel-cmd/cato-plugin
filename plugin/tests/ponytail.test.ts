import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { keepTestSummary, optimizeOutput } from '../hooks/lib/compress.ts'

// Integração com o Ponytail: o CATO só lê o que ele publica (settings, ~/.claude/.ponytail-active e
// ~/.claude/.ponytail-band). Caminhos POSIX; no Windows o motor põe a letra do drive, que norm tira.

const PT = { options: { language: 'pt' } }
const norm = (p: unknown) => String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const CMD = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 110 } })
const run = async ($: Engine, command: string, args = '') =>
  String(((await $.command.run(CMD(command, args))) as { text?: string }).text).replace(/\s+/g, ' ')

type World = { files: Record<string, string>; output: number; statuses: string[] }

/** Máquina com o Ponytail habilitado nas settings do usuário; `files` muda ao longo do teste. */
function world(on: On, files: Record<string, string> = {}): World & { clock: ReturnType<typeof mock.clock> } {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 15, 15) })
  mock.env(on, { HOME: '/home/t', USERPROFILE: '/home/t' })
  const w: World = {
    files: { '/home/t/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'ponytail@ponytail': true } }), ...files },
    output: 500,
    statuses: [],
  }
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 50_000, window: 1_000_000, percent: 5 }, rateLimits: [], cost: { usd: 1.23 } } }))
  on('fs.read', (_, e) => (norm(e.path) in w.files ? { value: w.files[norm(e.path)] } : { deny: 'missing' }))
  on('fs.exists', (_, e) => ({ value: norm(e.path) in w.files }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.status', (_, e) => {
    w.statuses.push(String(e.text ?? ''))
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.step', async function* (_, e) {
    const usage = { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: w.output, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  return Object.assign(w, { clock })
}

/** O motor mede a sessão: é quando o CATO refaz o status. */
const measure = ($: Engine) =>
  $.session.measure({ context: { tokens: 50_000, window: 1_000_000, percent: 5 }, rateLimits: [], cost: { usd: 1.23 }, changed: [] } as never)

async function step($: Engine) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of stream) {
    // só consome
  }
}

test('/cato-doctor detecta o Ponytail e sugere tirar as regras dele dos subagentes só de leitura', PT, async ($, on) => {
  world(on, { '/home/t/.claude/.ponytail-active': 'full\n' })
  const out = await run($, 'cato-doctor')
  expect(out).toContain('Ponytail detectado (nível: full)')
  expect(out).toContain('"PONYTAIL_SUBAGENT_MATCHER": "^(?!.*explore)"')
  expect(out).toContain('Faixa do Ponytail visível')
})

test('/cato-doctor: matcher já definido no env das settings e faixa desligada', PT, async ($, on) => {
  world(on, {
    '/home/t/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'ponytail@ponytail': true }, env: { PONYTAIL_SUBAGENT_MATCHER: 'general' } }),
    '/home/t/.claude/.ponytail-band': 'off',
  })
  const out = await run($, 'cato-doctor')
  expect(out).toContain('Ponytail detectado (nível: off)')
  expect(out).toContain('só chegam aos subagentes que casam com general')
  expect(out).not.toContain('Faixa do Ponytail visível')
})

test('/cato-doctor sem o Ponytail não fala dele', PT, async ($, on) => {
  world(on, { '/home/t/.claude/settings.json': '{}' })
  expect(await run($, 'cato-doctor')).not.toContain('Ponytail')
})

test('/cato mostra saída e custo por nível do Ponytail e compara ligado com desligado', PT, async ($, on) => {
  const w = world(on, { '/home/t/.claude/.ponytail-active': 'full' })
  w.output = 400
  await step($)
  await step($)
  // Desligado: o arquivo de nível some; o CATO relê depois de 30 s
  delete w.files['/home/t/.claude/.ponytail-active']
  await w.clock.advance(31_000)
  w.output = 1000
  await step($)
  const out = await run($, 'cato')
  expect(out).toContain('Ponytail — conversa principal por nível')
  expect(out).toMatch(/full 2 400 /)
  expect(out).toMatch(/desligado 1 1 mil /)
  expect(out).toContain('cada chamada escreveu 60% menos tokens de saída')
})

test('sem o Ponytail instalado, o /cato não tem a seção dele', PT, async ($, on) => {
  world(on, { '/home/t/.claude/settings.json': '{}' })
  await step($)
  expect(await run($, 'cato')).not.toContain('Ponytail')
})

test('com a faixa do Ponytail visível, o status do CATO não repete o custo da sessão', PT, async ($, on) => {
  const w = world(on, { '/home/t/.claude/.ponytail-active': 'full' })
  await step($)
  await measure($)
  const last = w.statuses.filter(Boolean).at(-1) ?? ''
  expect(last).toContain('CATO · ctx')
  expect(last).not.toContain('sessão')
})

test('sem o Ponytail, o status mostra o custo da sessão', PT, async ($, on) => {
  const w = world(on, { '/home/t/.claude/settings.json': '{}' })
  await step($)
  await measure($)
  expect(w.statuses.filter(Boolean).at(-1) ?? '').toContain('sessão')
})

test('compressão de testes mantém as linhas de resumo que a faixa do Ponytail conta', () => {
  const raw = [
    ...Array.from({ length: 80 }, (_, i) => `PASS src/mod${i}.test.ts`),
    'FAIL src/broken.test.ts',
    ...Array.from({ length: 260 }, (_, i) => `  at frame ${i} (src/broken.ts:${i}:1)`),
    'Tests:       2 failed, 80 passed, 82 total',
    'Time:        3.2 s',
  ].join('\n')
  const out = optimizeOutput('npx jest', raw)
  expect(out.changed).toBe(true)
  expect(out.text).toContain('Tests:       2 failed, 80 passed, 82 total')
  // Resumo que a compressão cortaria volta no fim, uma vez só
  expect(keepTestSummary('a\n# pass 5\n# fail 1\nb', 'a\nb')).toBe('a\nb\n# pass 5\n# fail 1')
  expect(keepTestSummary('x\n3 passed in 1s', 'x\n3 passed in 1s')).toBe('x\n3 passed in 1s')
})
