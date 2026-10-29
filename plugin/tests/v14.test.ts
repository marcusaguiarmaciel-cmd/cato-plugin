import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PT = { options: { language: 'pt' } }

// ~8k tokens estimados, em 400 linhas: grande para o sandbox padrão (6k)
const BIG = Array.from({ length: 400 }, (_, i) => `linha ${i} ${'x'.repeat(70)}`).join('\n')
const TERMINAL = Array.from({ length: 300 }, (_, i) => `saida ${i} ${'y'.repeat(70)}`).join('\n')

function mcp(on: On, text: string) {
  mock.store(on)
  mock.clock(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\teste' })
  on('fs.write', () => ({ value: undefined }))
  on('tool.call', () => ({ result: [{ type: 'text', text }], text }))
}

test('sandbox MCP: terminal e ferramentas do app chegam inteiros', PT, async ($, on) => {
  mcp(on, TERMINAL)
  expect(String((await $.tool.call({ tool: 'mcp__terminal__read_terminal', lines: 300 })).text)).toBe(TERMINAL)
  expect(String((await $.tool.call({ tool: 'mcp__ccd_session_mgmt__get_session', id: 'x' })).text)).toBe(TERMINAL)
})

test('sandbox MCP: resposta grande mostra começo e fim; a mesma chamada de novo vem inteira', PT, async ($, on) => {
  mcp(on, BIG)
  const first = String((await $.tool.call({ tool: 'mcp__docs__read', id: 'doc1' })).text)
  expect(first).toContain('[CATO MCP Sandbox #sbx_')
  expect(first).toContain('linha 0 ')
  expect(first).toContain('linha 399 ')
  expect(first.length).toBeLessThan(BIG.length / 4)
  expect(String((await $.tool.call({ tool: 'mcp__docs__read', id: 'doc1' })).text)).toBe(BIG)
  // Outra entrada é outra chamada: vai para o sandbox
  expect(String((await $.tool.call({ tool: 'mcp__docs__read', id: 'doc2' })).text)).toContain('[CATO MCP Sandbox')
})

test('sandbox MCP: limite pedido pelo modelo, limiar e sandboxSkip deixam a resposta inteira', { options: { language: 'pt', sandboxSkip: 'mcp__clickup__' } }, async ($, on) => {
  mcp(on, BIG)
  expect(String((await $.tool.call({ tool: 'mcp__docs__search', query: 'a', limit: 50 })).text)).toBe(BIG)
  expect(String((await $.tool.call({ tool: 'mcp__clickup__get_task', id: '1' })).text)).toBe(BIG)
})

test('sandbox MCP: abaixo do limiar configurado nada muda', { options: { language: 'pt', sandboxMinTokens: 20_000 } }, async ($, on) => {
  mcp(on, BIG)
  expect(String((await $.tool.call({ tool: 'mcp__docs__read', id: 'doc1' })).text)).toBe(BIG)
})

test('leituras pesadas: build/ versionado passa; node_modules nega uma vez e libera na segunda', PT, async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const checked: string[] = []
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    if (argv[0] === 'git' && argv[1] === 'check-ignore') {
      checked.push(argv[3])
      return { value: { exitCode: argv[3].includes('node_modules') ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', () => ({ value: { size: 40_000, kind: 'file', mtimeMs: 1, isLink: false } }))
  on('tool.call', () => ({ result: { file: { content: 'ok' } } }))

  expect((await $.tool.call({ tool: 'Read', file_path: 'src/build/x.ts' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: 'src/build/y.ts' })).deny).toBeUndefined()
  expect(checked).toEqual(['src/build']) // cache por pasta

  const first = await $.tool.call({ tool: 'Read', file_path: 'web/node_modules/react/index.js' })
  expect(String(first.deny)).toContain('second attempt goes through')
  expect((await $.tool.call({ tool: 'Read', file_path: 'web/node_modules/react/index.js' })).deny).toBeUndefined()

  // Lockfile nega sem consultar o git
  expect(String((await $.tool.call({ tool: 'Read', file_path: 'package-lock.json' })).deny)).toContain('[CATO]')
  expect(checked).toEqual(['src/build', 'web/node_modules'])
})

test('leituras pesadas: caminho citado no prompt passa direto, mesmo quando o Read usa caminho absoluto', PT, async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('session.cwd', () => ({ value: 'C:/build/meu-projeto' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: { file: { content: 'ok' } } }))
  // Pasta pai fora do projeto chamada build/ não bloqueia arquivos normais do projeto
  expect((await $.tool.call({ tool: 'Read', file_path: 'C:/build/meu-projeto/src/app.ts' })).deny).toBeUndefined()
  // Caminho relativo citado no prompt libera o Read com caminho absoluto
  await $.prompt.submit({ text: 'olhe o web/package-lock.json para ver a versão', wait: false, origin: { kind: 'composer' } })
  expect((await $.tool.call({ tool: 'Read', file_path: 'C:/build/meu-projeto/web/package-lock.json' })).deny).toBeUndefined()
})

test('guard depois de reload: o retrato da sessão no store faz o prompt ser segurado com o cache expirado', PT, async ($, on) => {
  const now = Date.UTC(2026, 9, 29, 15)
  mock.store(on, {
    sessions: { s1: { lastStepAt: now - 2 * 3_600_000, lastModel: 'claude-opus-5-5', lastCtx: 300_000, compactedAt: 0 } },
  })
  mock.clock(on, { now })
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 300_000, window: 1_000_000, percent: 30 }, rateLimits: [] } }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const held = await $.prompt.submit({ text: 'continuar', wait: false, origin: { kind: 'composer' } })
  expect(String(held.drop)).toContain('300.000')
  // Reenviar passa
  expect((await $.prompt.submit({ text: 'continuar', wait: false, origin: { kind: 'composer' } })).drop).toBeUndefined()
})

test('ledger: contagens de chamadas concorrentes não se perdem', PT, async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('tool.call', () => ({ result: { file: { content: 'ok' } } }))
  on('fs.stat', () => ({ value: { size: 3_800, kind: 'file', mtimeMs: 1, isLink: false } }))
  const files = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'a/Cargo.lock', 'b/uv.lock', 'c/poetry.lock']
  await Promise.all(files.map(file_path => $.tool.call({ tool: 'Read', file_path })))
  const out = await $.command.run({ command: 'cato', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(String((out as { text?: string }).text)).toMatch(/Leituras pesadas negadas\s+6×\s+6 mil/)
})

test('warmCache: aquece no máximo 2 vezes por pausa e o /cato mostra custo e reescrita evitada', { options: { language: 'pt', warmCache: true, cacheTtlMinutes: 60 } }, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 29, 12) })
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 200_000, window: 1_000_000, percent: 20 }, rateLimits: [] } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const usage = { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0 }
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  let forks = 0
  on('model.fork', () => {
    forks += 1
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0 } } }
  }) 

  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of stream) {
    // só consome
  }
  await clock.advance(57 * 60_000)
  expect(forks).toBe(1)
  await clock.advance(57 * 60_000)
  expect(forks).toBe(2)
  await clock.advance(57 * 60_000)
  expect(forks).toBe(2)

  // Volta quase 3h depois da última chamada real, com o cache ainda quente: a reescrita evitada é creditada
  expect((await $.prompt.submit({ text: 'voltei', wait: false, origin: { kind: 'composer' } })).drop).toBeUndefined()
  const out = await $.command.run({ command: 'cato', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 200 } })
  expect(String((out as { text?: string }).text)).toMatch(/Cache mantido quente \(warmCache, experimental\): 2 chamadas custaram US\$ 0,\d+ e evitaram US\$ 1,5\d/)
})

test('warmCache desligado (padrão): nenhum fork', PT, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  const usage = { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0 }
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  let forks = 0
  on('model.fork', () => {
    forks += 1
    return { value: { isAnswered: false, reason: 'nothing-to-fork' } }
  })
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of stream) {
    // só consome
  }
  await clock.advance(3 * 3_600_000)
  expect(forks).toBe(0)
})

test('custo fixo: descrições e lembretes são medidos sem alterar o que vai para a API', PT, async ($, on) => {
  mock.store(on)
  mock.clock(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\t' })
  on('session.cwd', () => ({ value: 'C:/proj' }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.describe', (_, e) => ({ description: e.description }))
  on('prompt.attachment', (_, e) => ({ text: e.text }))
  const described = await $.tool.describe({ tool: 'mcp__x__big', description: 'd'.repeat(3_800), provider: { plugin: 'mcp:x', tier: 'user' } })
  expect(described.description).toBe('d'.repeat(3_800))
  const attached = await $.prompt.attachment({ type: 'todo_reminder', text: 'r'.repeat(380), origin: { kind: 'engine' } } as never)
  expect(attached.text).toBe('r'.repeat(380))
  const out = await $.command.run({ command: 'cato-doctor', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 200 } })
  const text = String((out as { text?: string }).text)
  expect(text).toContain('Ferramentas de mcp:x: 1 (0 atrás do ToolSearch), ≈ 1 mil tokens')
  expect(text).toContain('Lembrete "todo_reminder": 1×, ≈ 100 tokens')
})
