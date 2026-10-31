import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// Cobre as ferramentas mcp__cato__* que não tinham teste próprio: repo_map, read_symbol, search_sandbox, cost_report
// (structural_search e graph_query estão em integrations.test.ts). Caminhos POSIX para rodar igual em qualquer sistema.

const PT = { options: { language: 'pt' } }
const norm = (p: unknown) => String(p).replace(/\\/g, '/')

const FILES: Record<string, string> = {
  '/proj/src/auth.ts': [
    "import { Database } from './db'",
    '',
    'export class AuthService {',
    '  login(user: string) {',
    '    return Database.find(user)',
    '  }',
    '',
    '  logout() {',
    '    return true',
    '  }',
    '}',
  ].join('\n'),
  '/proj/src/db.ts': ['export class Database {', '  static find(id: string) {', '    return id', '  }', '}'].join('\n'),
  '/home/t/.cato/sandbox/sbx_0123abcd.json': JSON.stringify({
    chunks: [
      { title: 'issue 1', content: 'login falha com token expirado' },
      { title: 'issue 2', content: 'layout quebrado no celular' },
    ],
  }),
  '/home/t/.cato/logs/cmd_89abcdef.log': ['npm install', 'added 10 packages', 'npm ERR! code ERESOLVE', 'done'].join('\n'),
}

// Caminho relativo ao projeto (como o repo_map lê) chega resolvido a partir da pasta do runner
const lookup = (p: unknown): string | undefined => {
  const path = norm(p)
  if (path in FILES) return path
  return Object.keys(FILES).find(k => k.startsWith('/proj/') && path.endsWith(k.slice('/proj'.length)))
}

function project(on: On) {
  mock.store(on)
  mock.clock(on)
  mock.env(on, { HOME: '/home/t' })
  on('session.cwd', () => ({ value: '/proj' }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('fs.exists', (_, e) => ({ value: !!lookup(e.path) }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: (FILES[lookup(e.path) ?? ''] ?? '').length, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => {
    const key = lookup(e.path)
    return key ? { value: FILES[key] } : { deny: 'missing' }
  })
  on('process.run', (_, e) =>
    e.argv[0] === 'git' && e.argv[1] === 'ls-files'
      ? { value: { exitCode: 0, stdout: 'src/auth.ts\nsrc/db.ts\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } },
  )
}

test('repo_map lista os arquivos do projeto com as declarações e suas linhas', PT, async ($, on) => {
  project(on)
  const ran = await $.tool.call({ tool: 'mcp__cato__repo_map', focus: 'auth' })
  const text = String(ran.result)
  expect(text).toContain('src/auth.ts')
  expect(text).toContain('AuthService')
  expect(text).toContain('src/db.ts')
})

test('read_symbol devolve só o método pedido, com as linhas; fora do projeto é negado', PT, async ($, on) => {
  project(on)
  const ran = await $.tool.call({ tool: 'mcp__cato__read_symbol', file_path: 'src/auth.ts', symbol: 'AuthService.login' })
  const text = String(ran.result)
  expect(text).toContain('[CATO Symbol Extract: AuthService.login in src/auth.ts (L4-L6)]')
  expect(text).toContain('Database.find(user)')
  expect(text).not.toContain('logout')

  const missing = await $.tool.call({ tool: 'mcp__cato__read_symbol', file_path: 'src/auth.ts', symbol: 'Nada' })
  expect(String(missing.result)).toContain("Symbol 'Nada' not found")

  const outside = await $.tool.call({ tool: 'mcp__cato__read_symbol', file_path: '../outro/x.ts', symbol: 'x' })
  expect(String(outside.deny)).toContain('outside the project')
})

test('search_sandbox busca no sandbox guardado e no log bruto; ID inválido ou inexistente é negado', PT, async ($, on) => {
  project(on)
  const sandbox = await $.tool.call({ tool: 'mcp__cato__search_sandbox', id: 'sbx_0123abcd', query: 'token expirado' })
  expect(String(sandbox.result)).toContain('=== [issue 1] ===')
  expect(String(sandbox.result)).not.toContain('layout quebrado')

  const log = await $.tool.call({ tool: 'mcp__cato__search_sandbox', id: '#cmd_89abcdef', query: 'ERESOLVE' })
  expect(String(log.result)).toContain('npm ERR! code ERESOLVE')

  const invalid = await $.tool.call({ tool: 'mcp__cato__search_sandbox', id: '../../segredo', query: 'x' })
  expect(String(invalid.deny)).toContain('Invalid ID')

  const gone = await $.tool.call({ tool: 'mcp__cato__search_sandbox', id: 'sbx_ffffffff', query: 'x' })
  expect(String(gone.deny)).toContain('not found')
})

test('cost_report responde mesmo sem custo registrado ainda', PT, async ($, on) => {
  project(on)
  const ran = await $.tool.call({ tool: 'mcp__cato__cost_report', days: 7 })
  expect(ran.deny).toBeUndefined()
  expect(String(ran.result).length).toBeGreaterThan(0)
})
