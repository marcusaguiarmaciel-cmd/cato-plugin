import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { maskOldToolResults } from '../hooks/lib/compaction.ts'

const norm = (p: unknown) => String(p).replace(/\\/g, '/')
const BIG_SOURCE = Array.from({ length: 3000 }, (_, i) => (i % 100 === 0 ? `export function f${i}() {` : i % 100 === 99 ? '}' : `  const v${i} = ${i}`)).join('\n')

function project(on: On) {
  mock.store(on)
  mock.clock(on)
  on('session.cwd', () => ({ value: 'C:/proj' }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: norm(e.path).endsWith('big.ts') ? BIG_SOURCE.length : 500, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: BIG_SOURCE }))
  on('tool.call', () => ({ result: { file: { content: 'conteúdo' } } }))
}

test('readGuard: Read inteiro de arquivo grande recebe o esqueleto; a segunda tentativa passa', { options: { readGuard: true } }, async ($, on) => {
  project(on)
  const first = await $.tool.call({ tool: 'Read', file_path: 'src/big.ts' })
  expect(String(first.deny)).toContain('[CATO] src/big.ts tem')
  expect(String(first.deny)).toMatch(/\[L1-L100\] export function f0\(\) \{/)
  const second = await $.tool.call({ tool: 'Read', file_path: 'src/big.ts' })
  expect(second.deny).toBeUndefined()
  // Com offset/limit, arquivo pequeno ou fora do projeto, nada muda
  expect((await $.tool.call({ tool: 'Read', file_path: 'src/other-big.ts', offset: 1, limit: 50 })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: 'src/small.ts' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: 'D:/outro/big.ts' })).deny).toBeUndefined()
})

test('readGuard desligado (padrão): Read grande passa direto', async ($, on) => {
  project(on)
  expect((await $.tool.call({ tool: 'Read', file_path: 'src/big.ts' })).deny).toBeUndefined()
})

const exchange = (i: number, size: number): SessionMessage[] => [
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: `t${i}`, tool: 'Bash', input: { command: `ls ${i}` } }], handle: `a${i}` },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: 'x'.repeat(size), isError: false }], handle: `u${i}` },
]

test('maskOldToolResults: só resultados grandes fora das últimas trocas, com o par tool_use/tool_result intacto', () => {
  const messages = Array.from({ length: 15 }, (_, i) => exchange(i, i % 2 ? 5_000 : 100)).flat()
  const { messages: out, masked } = maskOldToolResults(messages, 10, 2_000)
  // trocas 0..4 ficam fora das 10 últimas; dessas, as ímpares (1 e 3) são grandes
  expect(masked).toBe(2)
  const user1 = out[3]
  expect(user1.handle).toBeUndefined()
  expect(user1.toolResults?.[0]).toMatchObject({ tool_use_id: 't1', isError: false })
  expect(String(user1.toolResults?.[0].text)).toContain('resultado de Bash omitido pelo CATO antes do resumo: 5000 caracteres')
  expect(out[1]).toBe(messages[1]) // pequeno: mesma mensagem, com handle
  expect(out[29]).toBe(messages[29]) // recente: intacta
  expect(maskOldToolResults(messages.slice(0, 6), 10, 2_000).masked).toBe(0) // conversa curta: nada
})

test('maskColdCompact: com cache quente a compactação recebe as mensagens intactas; com cache frio, mascaradas', { options: { maskColdCompact: true } }, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 28, 10) })
  on('ui.status', () => ({ value: undefined }))
  const seen: number[] = []
  on('session.compact', (_, e) => {
    seen.push(e.messages.filter(m => m.toolResults?.some(r => r.text.includes('omitido pelo CATO'))).length)
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
})
