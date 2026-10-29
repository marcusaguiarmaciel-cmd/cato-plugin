import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { priceFor, sameModel, usageCost } from '../hooks/lib/pricing.ts'

// Textos para a pessoa em português, sem depender do idioma da máquina que roda os testes
const PT = { options: { language: 'pt' } }

type Usage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const CATO_CMD = { command: 'cato', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }

const MSG = { role: 'user' as const, text: 'resumo', toolUses: [] }

const usage = (model: string, read: number, write: number): Usage => ({
  model,
  input_tokens: 10,
  output_tokens: 500,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})

/** O mundo abaixo do plugin para o custo: `turn.step` responde com o `usage` da vez e a compactação conclui. */
function world(on: On) {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 28, 15) })
  const state: { usage: Usage | null } = { usage: null }
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: state.usage }
  })
  on('session.compact', () => ({ messages: [MSG] }))
  const toasts: string[] = []
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: string }).text ?? e))
    return { value: undefined }
  })
  return { clock, state, toasts }
}

async function step($: Engine, agentId?: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 3, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) {
    // só consome
  }
  return stream.result
}

async function report($: Engine): Promise<string> {
  return String(((await $.command.run(CATO_CMD)) as { text?: string }).text)
}

test('precompute não conta como compactação; a reescrita após /compact é reconstrução esperada, não miss', PT, async ($, on) => {
  const { clock, state } = world(on)

  state.usage = usage('claude-opus-5-5', 200_000, 5_000)
  await step($)
  await clock.advance(60_000)

  // precompute só prepara um resumo: a reescrita seguinte continua sendo um miss comum
  await $.session.compact({ trigger: 'precompute', messages: [MSG] })
  state.usage = usage('claude-opus-5-5', 0, 200_000)
  await step($)
  let text = await report($)
  expect(text).toMatch(/Outras \(prefixo mudou\)\s+1×/)
  expect(text).toContain('Reconstruções esperadas após compactar (não são misses): 0×')

  // compactação de verdade: a próxima escrita grande é esperada
  await clock.advance(60_000)
  await $.session.compact({ trigger: 'manual', messages: [MSG] })
  state.usage = usage('claude-opus-5-5', 0, 150_000)
  await step($)
  text = await report($)
  expect(text).toMatch(/Outras \(prefixo mudou\)\s+1×/)
  expect(text).toContain('Reconstruções esperadas após compactar (não são misses): 1×')
})

test('subagente: custo à parte com TTL de 5 min e sem mexer no estado de cache da conversa principal', PT, async ($, on) => {
  const { clock, state } = world(on)

  state.usage = usage('claude-opus-5-5', 200_000, 5_000)
  await step($)
  await clock.advance(60_000)

  // subagentes: um em outro modelo; outro escrevendo 1M tokens a preço de 5 min ($5) + output ($0,01)
  state.usage = usage('claude-haiku-5-5', 0, 0)
  await step($, 'agent-1')
  state.usage = usage('claude-opus-5-5', 0, 1_000_000)
  await step($, 'agent-2')
  await clock.advance(60_000)

  // se o subagente tivesse sobrescrito lastModel, esta escrita viraria "troca de modelo"
  state.usage = usage('claude-opus-5-5', 0, 150_000)
  await step($)

  const text = await report($)
  expect(text).toMatch(/Troca de modelo\s+0×/)
  expect(text).toMatch(/Outras \(prefixo mudou\)\s+1×/)
  expect(text).toContain('Subagentes: US$ 5,01 em 2 chamadas')
  expect(text).toMatch(/hoje\s+US\$ \d+,\d+\s+2\s/)
})

test('modelo sem preço conhecido não ganha preço de Opus: fica fora do custo e é contado', PT, async ($, on) => {
  const { state } = world(on)
  state.usage = usage('modelo-desconhecido-1', 1_000, 1_000)
  await step($)
  const text = await report($)
  expect(text).toContain('1 chamadas de modelo sem preço conhecido')
  expect(text).toMatch(/hoje\s+US\$ 0,00/)
})

test('preços: id completo, alias, sufixo [1m] e modelo desconhecido', PT, () => {
  expect(priceFor('claude-opus-5-5')?.output).toBe(20)
  expect(priceFor('claude-opus-5-5[1m]')?.output).toBe(20)
  expect(priceFor('opus')?.output).toBe(20)
  expect(priceFor('claude-sonnet-4-6')?.output).toBe(15)
  expect(priceFor('gpt-5')).toBeNull()
  expect(usageCost('gpt-5', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 }, 60)).toBeNull()
})

test('sameModel: alias casa com a família; opusplan e vazio são "não sei"', PT, () => {
  expect(sameModel('opus', 'claude-opus-5-5')).toBe(true)
  expect(sameModel('claude-opus-5-5[1m]', 'claude-opus-5-5')).toBe(true)
  expect(sameModel('sonnet', 'claude-opus-5-5')).toBe(false)
  expect(sameModel('claude-sonnet-5-5', 'claude-opus-5-5')).toBe(false)
  expect(sameModel('opusplan', 'claude-opus-5-5')).toBeNull()
  expect(sameModel('', 'claude-opus-5-5')).toBeNull()
})

test('compactação: instruções do CATO entram só quando ninguém deu as suas, inclusive no precompute', PT, async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  const seen: (string | undefined)[] = []
  on('session.compact', (_, e) => {
    seen.push(e.instructions)
    return { messages: [MSG] }
  })
  await $.session.compact({ trigger: 'auto', messages: [MSG] })
  await $.session.compact({ trigger: 'manual', messages: [MSG], instructions: 'foque no bug de login' })
  await $.session.compact({ trigger: 'precompute', messages: [MSG] })
  await $.session.compact({ trigger: 'auto', messages: [MSG], agentId: 'agent-1' })
  expect(String(seen[0])).toContain('the decisions made')
  expect(seen[1]).toBe('foque no bug de login')
  expect(String(seen[2])).toContain('the decisions made')
  expect(seen[3]).toBeUndefined()
})

test('troca de modelo com cache quente: um aviso com o custo, sem segurar o prompt', PT, async ($, on) => {
  const { clock, state, toasts } = world(on)
  let current = 'claude-opus-5-5'
  on('session.model', () => ({ value: current }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 200_000, window: 1_000_000, percent: 20 }, rateLimits: [] } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const submit = () => $.prompt.submit({ text: 'oi', wait: false, origin: { kind: 'composer' } })

  state.usage = usage('claude-opus-5-5', 200_000, 5_000)
  await step($)
  await clock.advance(60_000)

  // mesmo modelo (alias): nada
  current = 'opus'
  expect((await submit()).drop).toBeUndefined()
  expect(toasts.filter(t => t.includes('Trocar de'))).toHaveLength(0)

  // outro modelo: um aviso com custo, prompt segue; repetir não avisa de novo
  current = 'claude-sonnet-5-5'
  expect((await submit()).drop).toBeUndefined()
  expect((await submit()).drop).toBeUndefined()
  const warned = toasts.filter(t => t.includes('Trocar de'))
  expect(warned).toHaveLength(1)
  expect(warned[0]).toContain('Trocar de claude-opus-5-5 para claude-sonnet-5-5 relê 200 mil tokens sem cache (≈ US$ 0,80)')
})
