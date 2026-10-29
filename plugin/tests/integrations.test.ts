import { expect, mock, test } from 'claude-code/testing'

const ISSUES = JSON.stringify([
  {
    id: 1,
    node_id: 'I_kwDOabc',
    number: 42,
    title: 'Falha no login',
    url: 'https://api.github.com/repos/o/r/issues/42',
    html_url: 'https://github.com/o/r/issues/42',
    comments_url: 'https://api.github.com/repos/o/r/issues/42/comments',
    user: { login: 'marcus', id: 9, node_id: 'U_x', avatar_url: 'https://avatars/x', type: 'User', site_admin: false },
    labels: [{ id: 3, node_id: 'L_x', name: 'bug', color: 'd73a4a', url: 'https://api.github.com/labels/bug' }],
    reactions: { total_count: 0, '+1': 0, url: 'https://api.github.com/reactions' },
    body: 'Detalhes do erro',
    closed_at: null,
  },
], null, 2)

const AST_GREP_STREAM = [
  { text: 'console.log(user)', range: { byteOffset: { start: 10, end: 27 }, start: { line: 4, column: 2 }, end: { line: 4, column: 19 } }, file: 'src/a.ts', lines: '  console.log(user)', language: 'TypeScript', metaVariables: { single: { A: { text: 'user' } }, multi: {}, transformed: {} } },
  { text: 'console.log(err)', range: { byteOffset: { start: 50, end: 66 }, start: { line: 9, column: 4 }, end: { line: 9, column: 20 } }, file: 'src/b.ts', lines: '    console.log(err)', language: 'TypeScript', metaVariables: { single: { A: { text: 'err' } }, multi: {}, transformed: {} } },
].map(m => JSON.stringify(m)).join('\n')

const GRAPH = JSON.stringify({
  nodes: [
    { id: 'auth', label: 'AuthService', source_file: 'src/auth.ts', source_location: 'L10', community: 1 },
    { id: 'db', label: 'Database', source_file: 'src/db.ts', community: 2 },
  ],
  links: [{ source: 'auth', target: 'db', relation: 'calls', confidence: 'EXTRACTED' }],
})

test('GitHub MCP: JSON sai sem campos de API, usuário vira login e labels viram nomes', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('tool.call', () => ({ result: [{ type: 'text', text: ISSUES }], text: ISSUES }))

  const ran = await $.tool.call({ tool: 'mcp__github__list_issues', owner: 'o', repo: 'r' })
  const text = String(ran.text)
  expect(text).not.toContain('node_id')
  expect(text).not.toContain('api.github.com')
  expect(text).toContain('"user":"marcus"')
  expect(text).toContain('"labels":["bug"]')
  expect(text).toContain('https://github.com/o/r/issues/42')
  expect(text).toContain('Detalhes do erro')
})

test('GitHub MCP: get_file_contents de lockfile é negado', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('tool.call', () => ({ result: [{ type: 'text', text: '{}' }], text: '{}' }))
  const ran = await $.tool.call({ tool: 'mcp__github__get_file_contents', owner: 'o', repo: 'r', path: 'package-lock.json' })
  expect(String(ran.deny)).toContain('[CATO]')
})

test('Serena: leitura sem max_answer_chars recebe o orçamento; um limite pedido pelo modelo fica', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const seen: unknown[] = []
  on('tool.call', (_, e) => {
    seen.push((e as unknown as { max_answer_chars?: number }).max_answer_chars)
    return { result: [{ type: 'text', text: '[]' }], text: '[]' }
  })

  await $.tool.call({ tool: 'mcp__serena__find_symbol', name_path_pattern: 'Auth', relative_path: 'src' })
  await $.tool.call({ tool: 'mcp__serena__find_symbol', name_path_pattern: 'Auth', max_answer_chars: 5000 })
  expect(seen).toEqual([20000, 5000])
})

test('Serena: leitura dentro de node_modules é negada', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('tool.call', () => ({ result: [{ type: 'text', text: 'x' }], text: 'x' }))
  const ran = await $.tool.call({ tool: 'mcp__serena__read_file', relative_path: 'node_modules/react/index.js' })
  expect(String(ran.deny)).toContain('[CATO]')
})

test('ast-grep MCP: find_code recebe max_results padrão', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  let max: unknown
  on('tool.call', (_, e) => {
    max = (e as unknown as { max_results?: number }).max_results
    return { result: [{ type: 'text', text: 'Found 0 matches' }], text: 'Found 0 matches' }
  })
  await $.tool.call({ tool: 'mcp__ast-grep__find_code', pattern: 'console.log($A)', project_folder: '.' })
  expect(max).toBe(60)
})

test('Graphify: leitura do graph.json bruto é negada em favor do relatório', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('tool.call', () => ({ result: { file: { content: '{}' } } }))
  const ran = await $.tool.call({ tool: 'Read', file_path: 'graphify-out/graph.json' })
  expect(String(ran.deny)).toContain('GRAPH_REPORT.md')
})

test('Bash: `ast-grep --json` vira uma linha por casamento, com linhas 1-based', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\teste' })
  on('fs.write', () => ({ value: undefined }))
  const big = Array.from({ length: 8 }, () => AST_GREP_STREAM).join('\n')
  on('tool.call', () => ({ result: { stdout: big, stderr: '', interrupted: false } }))

  const ran = await $.tool.call({ tool: 'Bash', command: "ast-grep run -p 'console.log($A)' --json=stream src" })
  const stdout = (ran.result as { stdout: string }).stdout
  expect(stdout).toContain('src/a.ts:L5-L5  [$A=user]')
  expect(stdout).toContain('(ast_grep_json)')
  expect(stdout).not.toContain('byteOffset')
})

test('structural_search roda o ast-grep e devolve casamentos compactos; caminho fora do projeto é negado', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('session.cwd', () => ({ value: 'C:/proj' }))
  const calls: string[][] = []
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    return e.argv[1] === '--version'
      ? { value: { exitCode: 0, stdout: 'ast-grep 0.39.0', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 0, stdout: AST_GREP_STREAM, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const ran = await $.tool.call({ tool: 'mcp__cato__structural_search', pattern: 'console.log($A)', lang: 'ts' })
  expect(String(ran.result)).toContain('2 match(es) in 2 file(s)')
  expect(String(ran.result)).toContain('src/b.ts:L10-L10  [$A=err]')
  expect(calls.at(-1)).toEqual(['ast-grep', 'run', '--pattern', 'console.log($A)', '--json=stream', '--lang', 'ts', '.'])

  const outside = await $.tool.call({ tool: 'mcp__cato__structural_search', pattern: 'x', path: '../outro' })
  expect(String(outside.deny)).toContain('outside the project')
})

test('graph_query responde a partir do grafo do Graphify', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('session.cwd', () => ({ value: 'C:/proj' }))
  on('fs.stat', () => ({ value: { kind: 'file', size: GRAPH.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: GRAPH }))

  const ran = await $.tool.call({ tool: 'mcp__cato__graph_query', term: 'auth' })
  const text = String(ran.result)
  expect(text).toContain('AuthService [src/auth.ts:L10]')
  expect(text).toContain('→ calls Database [src/db.ts]')
})
