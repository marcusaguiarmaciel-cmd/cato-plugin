import { expect, test } from 'claude-code/testing'

import { compressGeneric, compressLinter, optimizeOutput } from '../hooks/lib/compress.ts'

/** pytest com muitos aprovados e 60 falhas, cada uma com várias linhas de detalhe. */
function pytestOutput(passed: number, failures: number): string {
  const lines = ['============ test session starts ============', 'platform linux -- Python 3.12', 'rootdir: /proj']
  for (let i = 0; i < passed; i++) lines.push(`tests/test_mod.py::test_ok_${i} PASSED [ ${Math.floor((i / passed) * 100)}%]`)
  lines.push('================== FAILURES ==================')
  for (let i = 0; i < failures; i++) {
    lines.push(`____________ test_falha_${i} ____________`, `    def test_falha_${i}():`, `>       assert calc(${i}) == ${i + 1}`, `E       AssertionError: assert ${i} == ${i + 1}`, `tests/test_mod.py:${100 + i}: AssertionError`)
  }
  lines.push('========= short test summary info =========')
  for (let i = 0; i < failures; i++) lines.push(`FAILED tests/test_mod.py::test_falha_${i} - AssertionError`)
  lines.push(`========= ${failures} failed, ${passed} passed in 12.34s =========`)
  return lines.join('\n')
}

test('pytest: aprovados somem; cada falha aparece ou a saída diz quantas linhas de erro ficaram de fora', () => {
  const raw = pytestOutput(3000, 60)
  const r = optimizeOutput('pytest -q', raw)
  expect(r.changed).toBe(true)
  expect(r.text.length).toBeLessThan(raw.length / 4)
  expect(r.text).toContain('60 failed, 3000 passed')
  const shown = Array.from({ length: 60 }, (_, i) => r.text.includes(`test_falha_${i}`)).filter(Boolean).length
  expect(shown === 60 || r.omittedErrors > 0).toBe(true)
})

test('pytest com falhas que cabem no limite: nenhuma linha de erro é omitida', () => {
  const r = optimizeOutput('pytest', pytestOutput(500, 20))
  expect(r.omittedErrors).toBe(0)
  for (let i = 0; i < 20; i++) expect(r.text).toContain(`AssertionError: assert ${i} == ${i + 1}`)
})

test('tsc com 500 erros em 40 arquivos: todo arquivo aparece ao menos uma vez', () => {
  const lines: string[] = []
  for (let i = 0; i < 500; i++) lines.push(`src/mod${i % 40}.ts(${i + 1},5): error TS2345: Argument of type 'string' is not assignable.`)
  const r = compressLinter(lines.join('\n'))
  expect(r.changed).toBe(true)
  for (let f = 0; f < 40; f++) expect(r.text).toContain(`src/mod${f}.ts(`)
  expect(r.omittedErrors).toBeGreaterThan(0)
  expect(r.text).toContain('Por arquivo:')
})

test('log de build: linhas de erro distintas do meio ficam, repetidas viram contagem', () => {
  const lines: string[] = []
  for (let i = 0; i < 400; i++) lines.push(i % 50 === 0 ? `error: falha no módulo ${i}` : i % 7 === 0 ? 'error: timeout' : `compilando ${i}`)
  const r = compressGeneric(lines.join('\n'))
  expect(r.changed).toBe(true)
  for (let i = 50; i < 350; i += 50) expect(r.text).toContain(`error: falha no módulo ${i}`)
  expect(r.text).toMatch(/error: timeout {2}\[\d+x\]/)
  expect(r.omittedErrors).toBe(0)
})

test('build com mais de 150 erros distintos no meio: o excedente é contado em omittedErrors', () => {
  const lines: string[] = []
  for (let i = 0; i < 400; i++) lines.push(`error: erro distinto ${i}`)
  const r = compressGeneric(lines.join('\n'))
  expect(r.omittedErrors).toBe(400 - 35 - 45 - 150)
})

test('CRLF, ANSI, Unicode e linha gigante não quebram a compressão', () => {
  const big = 'x'.repeat(50_000)
  const lines = Array.from({ length: 300 }, (_, i) => `\x1b[32mpacote ${i} ✓ instalado\x1b[0m`)
  lines.splice(150, 0, big, 'erro: dependência ausente ção')
  const r = optimizeOutput('npm install', lines.join('\r\n'))
  expect(r.changed).toBe(true)
  expect(r.text).not.toContain('\x1b[')
  expect(r.text).not.toContain('\r')
})

test('saída fora das categorias ruidosas volta igual', () => {
  const raw = Array.from({ length: 300 }, (_, i) => `linha ${i}`).join('\n')
  const r = optimizeOutput('python script.py', raw)
  expect(r.changed).toBe(false)
  expect(r.text).toBe(raw)
})
