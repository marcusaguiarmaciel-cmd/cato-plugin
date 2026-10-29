import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { extractSymbol, skeleton } from '../hooks/lib/codeintel.ts'
import { maskOldToolResults } from '../hooks/lib/compaction.ts'

// Textos para a pessoa em português, sem depender do idioma da máquina que roda os testes
const PT = { options: { language: 'pt' } }

const norm = (p: unknown) => String(p).replace(/\\/g, '/')
const BIG_SOURCE = Array.from({ length: 3000 }, (_, i) => (i % 100 === 0 ? `export function f${i}() {` : i % 100 === 99 ? '}' : `  const v${i} = ${i}`)).join('\n')

function project(on: On) {
  mock.store(on)
  mock.clock(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\t' })
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.cwd', () => ({ value: 'C:/proj' }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: norm(e.path).endsWith('big.ts') ? BIG_SOURCE.length : 500, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: BIG_SOURCE }))
  on('tool.call', () => ({ result: { file: { content: 'conteúdo' } } }))
}

test('readGuard: Read inteiro de arquivo grande recebe o esqueleto; a segunda tentativa passa', { options: { language: 'pt', readGuard: true } }, async ($, on) => {
  project(on)
  const first = await $.tool.call({ tool: 'Read', file_path: 'src/big.ts' })
  expect(String(first.deny)).toContain('[CATO] src/big.ts is')
  expect(String(first.deny)).toMatch(/\[L1-L100\] export function f0\(\) \{/)
  const report = async () => String(((await $.command.run(CMD(''))) as { text?: string }).text)
  // Desvio: credita o arquivo menos o esqueleto; pedido de novo: desconta o arquivo (fica só o custo do esqueleto)
  expect(await report()).toMatch(/Leituras grandes trocadas pelo esqueleto\s+1×\s+[\d,]+ mil/)
  const second = await $.tool.call({ tool: 'Read', file_path: 'src/big.ts' })
  expect(second.deny).toBeUndefined()
  expect(await report()).toMatch(/Leituras grandes trocadas pelo esqueleto\s+1×\s+-[\d,]+( mil)?\s+\(1 pedidas de novo e descontadas\)/)
  // Com offset/limit, arquivo pequeno ou fora do projeto, nada muda
  expect((await $.tool.call({ tool: 'Read', file_path: 'src/other-big.ts', offset: 1, limit: 50 })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: 'src/small.ts' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: 'D:/outro/big.ts' })).deny).toBeUndefined()
})

test('readGuard desligado (padrão): Read grande passa direto', PT, async ($, on) => {
  project(on)
  expect((await $.tool.call({ tool: 'Read', file_path: 'src/big.ts' })).deny).toBeUndefined()
})

const exchange = (i: number, size: number): SessionMessage[] => [
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: `t${i}`, tool: 'Bash', input: { command: `ls ${i}` } }], handle: `a${i}` },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: 'x'.repeat(size), isError: false }], handle: `u${i}` },
]

test('maskOldToolResults: só resultados grandes fora das últimas trocas, com o par tool_use/tool_result intacto', PT, () => {
  const messages = Array.from({ length: 15 }, (_, i) => exchange(i, i % 2 ? 5_000 : 100)).flat()
  const { messages: out, masked } = maskOldToolResults(messages, 10, 2_000)
  // trocas 0..4 ficam fora das 10 últimas; dessas, as ímpares (1 e 3) são grandes
  expect(masked).toBe(2)
  const user1 = out[3]
  expect(user1.handle).toBeUndefined()
  expect(user1.toolResults?.[0]).toMatchObject({ tool_use_id: 't1', isError: false })
  expect(String(user1.toolResults?.[0].text)).toContain('[Bash result omitted by CATO before the summary: 5000 characters]')
  expect(out[1]).toBe(messages[1]) // pequeno: mesma mensagem, com handle
  expect(out[29]).toBe(messages[29]) // recente: intacta
  expect(maskOldToolResults(messages.slice(0, 6), 10, 2_000).masked).toBe(0) // conversa curta: nada
})

test('maskColdCompact: com cache quente a compactação recebe as mensagens intactas; com cache frio, mascaradas', { options: { language: 'pt', maskColdCompact: true } }, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 28, 10) })
  on('ui.status', () => ({ value: undefined }))
  const seen: number[] = []
  on('session.compact', (_, e) => {
    seen.push(e.messages.filter(m => m.toolResults?.some(r => r.text.includes('omitted by CATO'))).length)
    return { messages: [{ role: 'user', text: 'resumo', toolUses: [] }] }
  })
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 },
    }
  })
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // consome
  }
  const messages = Array.from({ length: 15 }, (_, i) => exchange(i, 5_000)).flat()
  await $.session.compact({ trigger: 'manual', messages })
  await clock.advance(2 * 60 * 60_000) // 2h parado: cache de 1h expirou
  await $.session.compact({ trigger: 'manual', messages })
  expect(seen).toEqual([0, 5])
  // 5 resultados de 5.000 caracteres viraram uma linha cada: ≈ 6k tokens a menos no resumo
  const report = String(((await $.command.run(CMD(''))) as { text?: string }).text)
  expect(report).toMatch(/Resultados antigos mascarados antes do resumo\s+1×\s+[\d,]+ mil/)
  expect(report).toMatch(/Total: [\d,]+ mil tokens a menos no contexto ≈ US\$ 0,05/)
})

const CMD = (args: string) => ({ command: 'cato', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

test('/cato experimental: ligar ativa os 3 com aviso de keep-alive e persiste; padrão volta a seguir o /plugin', PT, async ($, on) => {
  project(on)
  const run = async (args: string) => String(((await $.command.run(CMD(args))) as { text?: string }).text)
  expect(await run('experimental')).toContain('readGuard desligado · maskColdCompact desligado · warmCache desligado (configuração do /plugin)')

  const turnedOn = await run('experimental ligar')
  expect(turnedOn).toContain('readGuard ligado · maskColdCompact ligado · warmCache ligado (escolhido por /cato-experimental)')
  expect(turnedOn).toContain('⚠ Aviso: o warmCache faz até 2 chamadas de keep-alive')
  expect(String((await $.tool.call({ tool: 'Read', file_path: 'src/big.ts' })).deny)).toContain('[CATO] src/big.ts is')
  expect(await run('doctor')).toContain('Experimentais em vigor: readGuard ligado, maskColdCompact ligado, warmCache ligado')

  // Também aceita desligar só o warmCache mantendo os outros dois ligados
  const withoutWarm = await run('experimental warmCache desligar')
  expect(withoutWarm).toContain('readGuard ligado · maskColdCompact ligado · warmCache desligado (escolhido por /cato-experimental)')
  expect(withoutWarm).not.toContain('⚠ Aviso:')

  expect(await run('experimental padrão')).toContain('readGuard desligado · maskColdCompact desligado · warmCache desligado (configuração do /plugin)')
  expect((await $.tool.call({ tool: 'Read', file_path: 'src/other-big.ts' })).deny).toBeUndefined()
})

test('/cato-experimental e /cato-doctor: comandos próprios fazem o mesmo que os subcomandos', PT, async ($, on) => {
  project(on)
  const run = async (command: string, args = '') => String(((await $.command.run({ ...CMD(args), command })) as { text?: string }).text)
  expect(await run('cato-experimental', 'Ligar')).toContain('readGuard ligado · maskColdCompact ligado · warmCache ligado (escolhido por /cato-experimental)')
  expect(await run('cato-doctor')).toContain('Experimentais em vigor: readGuard ligado, maskColdCompact ligado, warmCache ligado')
  expect(await run('cato-experimental', 'padrão')).toContain('readGuard desligado · maskColdCompact desligado · warmCache desligado (configuração do /plugin)')
})

test('/cato experimental desligar vale por cima do /plugin', { options: { language: 'pt', readGuard: true, maskColdCompact: true, warmCache: true } }, async ($, on) => {
  project(on)
  const text = String(((await $.command.run(CMD('experimental desligar'))) as { text?: string }).text)
  expect(text).toContain('readGuard desligado · maskColdCompact desligado · warmCache desligado')
  expect((await $.tool.call({ tool: 'Read', file_path: 'src/big.ts' })).deny).toBeUndefined()
})

test('extractSymbol e skeleton: chaves dentro de strings, regexes e comentários não quebram o bloco', () => {
  const src = [
    'export function parseBraces(input: string) {',
    '  // comentário com } solta',
    '  const re = /\\{/g',
    '  const ch = "{"',
    "  if (input.includes('{')) {",
    '    return input.replace(re, "}")',
    '  }',
    '  return input',
    '}',
    'export function nextFn() {',
    '  return 1',
    '}',
  ].join('\n')
  const sym = extractSymbol('src/parse.ts', src, 'parseBraces')
  expect(sym).toMatchObject({ start: 1, end: 9 })
  expect(skeleton('src/parse.ts', src)).toContain('[L1-L9] export function parseBraces(input: string) {')
  expect(skeleton('src/parse.ts', src)).toContain('[L10-L12] export function nextFn() {')
})

test('relatório: economia do RTK pelo rtk gain entra na soma, só dos dias do período', PT, async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.UTC(2026, 9, 28, 15) })
  const daily = [
    { date: '2026-10-28', commands: 10, saved_tokens: 400_000 },
    { date: '2026-10-27', commands: 5, saved_tokens: 100_000 },
    { date: '2026-01-01', commands: 99, saved_tokens: 9_000_000 },
  ]
  on('process.run', (_, e) =>
    e.argv[0] === 'rtk'
      ? { value: { exitCode: 0, stdout: JSON.stringify({ summary: {}, daily }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } },
  )
  const text = String(((await $.command.run(CMD('7'))) as { text?: string }).text)
  expect(text).toMatch(/Comandos reescritos pelo RTK\s+15×\s+500 mil/)
  expect(text).toMatch(/Total: 500 mil tokens a menos no contexto ≈ US\$ \d+,\d+/)
})

test('ast-grep fora do PATH: o binário do npm global em %APPDATA% é encontrado', PT, async ($, on) => {
  const bin = 'C:/Users/t/AppData/Roaming/npm/node_modules/@ast-grep/cli/ast-grep.exe'
  mock.store(on)
  mock.clock(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\t', APPDATA: 'C:\\Users\\t\\AppData\\Roaming' })
  on('session.cwd', () => ({ value: 'C:/proj' }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: norm(e.path) === bin }))
  on('process.run', (_, e) =>
    norm(e.argv[0]) === bin
      ? { value: { exitCode: 0, stdout: 'ast-grep 0.51.0', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } },
  )
  const text = String(((await $.command.run({ ...CMD(''), command: 'cato-doctor' })) as { text?: string }).text)
  expect(text).toContain('ast-grep instalado')
})

test('/cato: período só muda com número escrito', PT, async ($, on) => {
  project(on)
  const run = async (args: string) => String(((await $.command.run(CMD(args))) as { text?: string }).text)
  expect(await run('')).toContain('CATO · Custo real — últimos 30 dias')
  expect(await run('  ')).toContain('últimos 30 dias')
  expect(await run('7')).toContain('últimos 7 dias')
  expect(await run('500')).toContain('últimos 90 dias')
})
