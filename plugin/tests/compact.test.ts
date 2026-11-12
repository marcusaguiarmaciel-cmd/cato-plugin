import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// /cato-compact: limite da autocompactação em tokens ou em % da janela, guardado no store do CATO

const PT = { options: { language: 'pt' } }
const CMD = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const run = async ($: { command: { run: (i: ReturnType<typeof CMD>) => Promise<unknown> } }, command: string, args = '') =>
  String(((await $.command.run(CMD(command, args))) as { text?: string }).text).replace(/\s+/g, ' ')

/** Sessão com `tokens` de contexto numa janela de 1M; devolve quantas compactações o CATO pediu e os toasts. */
function session(on: On, tokens: number, stored: Record<string, unknown> = {}) {
  mock.store(on, stored)
  mock.clock(on, { now: Date.UTC(2026, 10, 12, 15) })
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1_000_000, percent: tokens / 10_000 }, rateLimits: [] } }))
  const seen = { compactions: 0, toasts: [] as string[] }
  on('session.compact', () => {
    seen.compactions += 1
    return { messages: [{ role: 'user' as const, text: 'resumo', toolUses: [] }] }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return seen
}

/** Fim de um turno: da conversa principal, ou de um subagente com `agentId`. */
const endTurn = ($: { turn: { complete: (i: never) => Promise<unknown> } }, agentId?: string) =>
  $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...(agentId ? { agentId } : {}) } as never)

test('/cato-compact 150k compacta quando o contexto passa de 150 mil tokens, mesmo abaixo da % do /plugin', PT, async ($, on) => {
  const seen = session(on, 160_000)
  expect(await run($, 'cato-compact', '150k')).toContain('150 mil tokens (definido com /cato-compact)')
  await endTurn($)
  expect(seen.compactions).toBe(1)
  expect(seen.toasts.join('\n')).toContain('160 mil tokens: compactado')
})

test('/cato-compact: abaixo do limite em tokens nada acontece', PT, async ($, on) => {
  const seen = session(on, 120_000)
  await run($, 'cato-compact', '150 k')
  await endTurn($)
  expect(seen.compactions).toBe(0)
})

test('/cato-compact aceita 150000, 1.5m e 65%; desligar e padrão; recusa valores inválidos ou baixos demais', PT, async ($, on) => {
  session(on, 10_000)
  expect(await run($, 'cato-compact', '150000')).toContain('150 mil tokens')
  expect(await run($, 'cato-compact', '1.5m')).toContain('1,5 mi tokens')
  expect(await run($, 'cato-compact', '40%')).toContain('40% da janela (definido com /cato-compact)')
  expect(await run($, 'cato-compact', 'desligar')).toContain('Autocompactação desligada (definido com /cato-compact)')
  expect(await run($, 'cato-compact', 'padrão')).toContain('65% da janela (das configurações do /plugin)')
  expect(await run($, 'cato-compact', 'muito')).toContain('não é um limite válido')
  expect(await run($, 'cato-compact', '5k')).toContain('Abaixo de 20 mil tokens')
  // Sem argumento: mostra o estado e como usar
  const shown = await run($, 'cato-compact')
  expect(shown).toContain('65% da janela')
  expect(shown).toContain('/cato-compact 150k')
  // O mesmo pelo /cato
  expect(await run($, 'cato', 'compactar 200k')).toContain('200 mil tokens')
})

test('subagente não dispara a autocompactação da conversa principal', PT, async ($, on) => {
  const seen = session(on, 300_000, { autoCompact: { tokens: 150_000 } })
  await endTurn($, 'agent-1')
  expect(seen.compactions).toBe(0)
})

test('/cato-compact desligar: nem a % do /plugin compacta', PT, async ($, on) => {
  const seen = session(on, 900_000, { autoCompact: { off: true } })
  await endTurn($)
  expect(seen.compactions).toBe(0)
})

test('a % do /plugin continua valendo sem /cato-compact', PT, async ($, on) => {
  const seen = session(on, 700_000)
  await endTurn($)
  expect(seen.compactions).toBe(1)
  expect(seen.toasts.join(' ')).toContain('70% da janela: compactado')
})

test('limite em tokens vale com o guard desligado', { options: { language: 'pt', guard: false } }, async ($, on) => {
  const seen = session(on, 300_000, { autoCompact: { tokens: 250_000 } })
  await endTurn($)
  expect(seen.compactions).toBe(1)
})
