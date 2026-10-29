import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { aggregate, AWK_EXTRACT, parseExtract, parseJsonlText } from '../hooks/lib/history.ts'

// Textos para a pessoa em português, sem depender do idioma da máquina que roda os testes
const PT = { options: { language: 'pt' } }

const CMD = (args: string) => ({ command: 'cato', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

const line = (o: Record<string, unknown>) => JSON.stringify(o)
const assistant = (id: string, ts: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  line({ isSidechain: false, message: { model: 'claude-opus-5-5', id, type: 'message', role: 'assistant', content: [], usage }, type: 'assistant', timestamp: ts, ...extra })
const usage = (input: number, cw: number, cr: number, out: number, oneHour = true) => ({
  input_tokens: input,
  cache_creation_input_tokens: cw,
  cache_read_input_tokens: cr,
  output_tokens: out,
  cache_creation: { ephemeral_1h_input_tokens: oneHour ? cw : 0, ephemeral_5m_input_tokens: oneHour ? 0 : cw },
})
const tsv = (id: string, ts: string, cw: number, cr: number, out: number) => `A\t${id}\tclaude-opus-5-5\t${ts}\t0\t10\t${cw}\t${cr}\t${out}\t${cw}\t0`

test('parseJsonlText: a mesma chamada em várias linhas conta uma vez (a de maior output); compactação e sidechain', PT, () => {
  const text = [
    assistant('msg_1', '2026-10-20T10:00:00Z', usage(10, 5_000, 0, 1)),
    assistant('msg_1', '2026-10-20T10:00:01Z', usage(10, 5_000, 0, 300)),
    line({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-20T11:00:00Z' }),
    assistant('msg_2', '2026-10-20T11:00:05Z', usage(10, 0, 0, 50), { isSidechain: true }),
    'linha quebrada {',
  ].join('\n')
  const events = parseJsonlText(text)
  const calls = events.filter(e => e.kind === 'call')
  expect(calls).toHaveLength(2)
  expect(calls.find(c => c.kind === 'call' && c.id === 'msg_1')).toMatchObject({ out: 300, cw1h: 5_000, cw5m: 0 })
  expect(calls.find(c => c.kind === 'call' && c.id === 'msg_2')).toMatchObject({ side: true })
  expect(events.filter(e => e.kind === 'compact')).toHaveLength(1)
})

test('parseExtract lê o formato dos extratores e ignora linhas fora dele', PT, () => {
  const events = parseExtract([tsv('msg_9', '2026-10-20T10:00:00Z', 1, 2, 3), 'C\t2026-10-20T11:00:00Z', 'lixo', 'A\tsem-msg'].join('\r\n'))
  expect(events).toHaveLength(2)
  expect(AWK_EXTRACT).toContain('compact_boundary')
})

test('aggregate: reconstrução após compactar, pausa longa, faixa de contexto, liveSince e ids repetidos', PT, () => {
  const t = (h: number) => Date.UTC(2026, 9, 20, h)
  const events = parseJsonlText([
    assistant('msg_a', new Date(t(10)).toISOString(), usage(10, 200_000, 0, 100)), // primeira: não é miss
    line({ type: 'system', subtype: 'compact_boundary', timestamp: new Date(t(11)).toISOString() }),
    assistant('msg_b', new Date(t(11) + 1000).toISOString(), usage(10, 150_000, 0, 100)), // reconstrução
    assistant('msg_c', new Date(t(14)).toISOString(), usage(10, 450_000, 0, 100)), // 3h parada: pausa
    assistant('msg_d', new Date(t(23)).toISOString(), usage(10, 0, 0, 100)), // depois do liveSince
  ].join('\n'))
  const seen = new Set<string>()
  const opts = { mainTtlMinutes: 60, subTtlMinutes: 5, liveSince: t(20), isSubFile: false }
  const r = aggregate(events, opts, seen)
  expect(r.calls).toBe(3)
  const day = Object.values(r.days)[0]
  expect(day.rebuilds).toBe(1)
  expect(day.missIdle).toBe(1)
  expect(day.missOther).toBe(0)
  expect(day.band3).toBeGreaterThan(0) // a chamada de 450k
  // o mesmo arquivo de novo (sessão retomada): nada conta duas vezes
  expect(aggregate(events, opts, seen).calls).toBe(0)
  // arquivo de subagente: vai para subCalls
  const sub = aggregate(parseJsonlText(assistant('msg_s', new Date(t(9)).toISOString(), usage(10, 0, 0, 1))), { ...opts, isSubFile: true }, seen)
  expect(Object.values(sub.days)[0]).toMatchObject({ subCalls: 1, calls: 0 })
})

// O engine pode entregar o caminho com \ no Windows
const norm = (p: unknown) => String(p).replace(/\\/g, '/')

/** Um ~/.claude com um projeto, uma sessão e um subagente, lidos pelo extrator (awk simulado). */
function claudeHome(on: On, written: string[], store: Record<string, unknown> = {}, awk = 'awk', abort = false) {
  mock.store(on, store)
  mock.clock(on, { now: Date.UTC(2026, 9, 28, 15) })
  mock.env(on, { USERPROFILE: 'C:\\Users\\t' })
  const root = 'C:/Users/t/.claude/projects'
  on('fs.exists', (_, e) => ({ value: norm(e.path).startsWith(root) || norm(e.path) === awk }))
  on('fs.list', (_, e) => {
    const path = norm(e.path)
    if (path === root) return { value: [{ name: 'proj', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    if (path === `${root}/proj`) {
      return {
        value: [
          { name: 's1.jsonl', kind: 'file', size: 200 * 1024 * 1024, mtimeMs: 1, isLink: false },
          { name: 's1', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
        ],
      }
    }
    if (path === `${root}/proj/s1/subagents`) return { value: [{ name: 'agent-x.jsonl', kind: 'file', size: 10, mtimeMs: 1, isLink: false }] }
    return { value: [] }
  })
  on('fs.write', (_, e) => {
    written.push(norm(e.path))
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const argv = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'git' && argv[1] === '--exec-path') return ok('C:/Program Files/Git/mingw64/libexec/git-core\n')
    if (norm(argv[0]) !== awk) return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[1].includes('BEGIN')) return ok('ok\n')
    if (abort) return { deny: 'cato: $.process.run(awk) aborted' }
    if (norm(argv[2]).endsWith('s1.jsonl')) {
      return ok([tsv('msg_1', '2026-10-20T10:00:00Z', 5_000, 100_000, 100), tsv('msg_2', '2026-10-21T10:00:00Z', 0, 120_000, 100)].join('\n'))
    }
    return ok(tsv('msg_3', '2026-10-21T11:00:00Z', 0, 0, 10).replace('\t0\t10\t', '\t1\t10\t'))
  })
}

test('/cato importar: arquivos grandes pelo extrator, subagentes à parte, e rodar de novo não duplica', PT, async ($, on) => {
  const written: string[] = []
  claudeHome(on, written)
  const first = String(((await $.command.run(CMD('importar'))) as { text?: string }).text)
  expect(first).toContain('2 arquivos lidos agora, 3 chamadas novas')
  expect(first).toContain('Extrator: awk')
  const report = String(((await $.command.run(CMD('30'))) as { text?: string }).text)
  expect(report).toContain('Inclui 3 chamadas importadas')
  expect(report).toMatch(/Subagentes: US\$ \d+,\d+ em 1 chamadas/)
  const again = String(((await $.command.run(CMD('importar'))) as { text?: string }).text)
  expect(again).toContain('0 arquivos lidos agora, 0 chamadas novas')
  expect(written).toHaveLength(0)
})

const BIG = 'C:/Users/t/.claude/projects/proj/s1.jsonl'
const GIT_AWK = 'C:/Program Files/Git/usr/bin/awk.exe'
const emptyHistory = (extra: Record<string, unknown>) => ({
  history: { liveSince: Date.UTC(2026, 9, 28), days: {}, files: {}, seen: [], calls: 0, first: 0, last: 0, ...extra },
})

test('/cato importar: arquivo em que a execução anterior parou com o mesmo extrator fica de fora até mudar', PT, async ($, on) => {
  claudeHome(on, [], emptyHistory({ pending: { path: BIG, size: 200 * 1024 * 1024, mtimeMs: 1, extractor: 'awk' } }))
  const text = String(((await $.command.run(CMD('importar'))) as { text?: string }).text)
  expect(text).toContain('1 arquivos lidos agora, 1 chamadas novas')
  expect(text).toContain('interrupted while reading')
})

test('/cato importar: sem awk no PATH usa o do Git, e o que falhou com o PowerShell é lido de novo', PT, async ($, on) => {
  const failed = { size: 200 * 1024 * 1024, mtimeMs: 1, status: 'failed', calls: 0, note: 'extrator falhou: cato: $.process.run(powershell) aborted' }
  claudeHome(on, [], emptyHistory({ files: { [BIG]: failed } }), GIT_AWK)
  const text = String(((await $.command.run(CMD('importar'))) as { text?: string }).text)
  expect(text).toContain(`Extrator: awk (${GIT_AWK})`)
  expect(text).toContain('2 arquivos lidos agora, 3 chamadas novas')
  expect(text).not.toContain('ficaram de fora')
})

test('/cato importar: leitura interrompida não marca o arquivo como falha', PT, async ($, on) => {
  claudeHome(on, [], {}, 'awk', true)
  const text = String(((await $.command.run(CMD('importar'))) as { text?: string }).text)
  expect(text).toContain('A leitura foi interrompida; faltam 2 arquivos')
  expect(text).not.toContain('ficaram de fora')
  expect(String(((await $.command.run(CMD('importar'))) as { text?: string }).text)).toContain('faltam 2 arquivos')
})

test('/cato doctor: aponta resto da versão Python e opusplan, e não escreve nada', PT, async ($, on) => {
  mock.store(on)
  mock.clock(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\t' })
  on('session.cwd', () => ({ value: 'C:/proj' }))
  const files: Record<string, string> = {
    'C:/Users/t/.claude/settings.json': JSON.stringify({ model: 'opusplan', hooks: { PreToolUse: [{ hooks: [{ command: 'python -m cato hook pre' }] }] } }),
    'C:/proj/CLAUDE.md': Array.from({ length: 250 }, (_, i) => `linha ${i}`).join('\n'),
  }
  on('fs.read', (_, e) => (norm(e.path) in files ? { value: files[norm(e.path)] } : { deny: 'missing' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  const writes: string[] = []
  on('fs.write', (_, e) => {
    writes.push(String(e.path))
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const text = String(((await $.command.run(CMD('doctor'))) as { text?: string }).text)
  expect(text).toContain('nada foi alterado')
  expect(text).toContain('❌ A versão Python do CATO ainda está configurada')
  expect(text).toContain('⚠️ model=opusplan')
  expect(text).toContain('⚠️ CLAUDE.md: 250 linhas')
  expect(writes).toHaveLength(0)
})
