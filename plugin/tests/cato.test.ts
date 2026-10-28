import { expect, mock, test } from 'claude-code/testing'

const NOISY_INSTALL = Array.from({ length: 300 }, (_, i) => `added package-${i}@1.0.${i} from registry`).join('\n')

test('leitura de lockfile ou node_modules é negada antes de encher o contexto', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('tool.call', () => ({ result: { file: { content: 'ok' } } }))

  const lock = await $.tool.call({ tool: 'Read', file_path: 'package-lock.json' })
  expect(String(lock.deny)).toContain('[CATO]')

  const deps = await $.tool.call({ tool: 'Read', file_path: 'web/node_modules/react/index.js' })
  expect(String(deps.deny)).toContain('[CATO]')

  const source = await $.tool.call({ tool: 'Read', file_path: 'src/app.ts' })
  expect(source.deny).toBeUndefined()
})

test('saída ruidosa de instalação é comprimida e o log bruto é guardado', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  mock.env(on, { USERPROFILE: 'C:\\Users\\teste' })
  const written: string[] = []
  on('fs.write', (_, e) => {
    written.push(e.path)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: { stdout: NOISY_INSTALL, stderr: '', interrupted: false } }))

  const ran = await $.tool.call({ tool: 'Bash', command: 'npm install' })
  const stdout = (ran.result as { stdout: string }).stdout
  expect(stdout).toContain('linhas intermediárias omitidas')
  expect(stdout).toContain('[CATO #cmd_')
  expect(stdout.length).toBeLessThan(NOISY_INSTALL.length / 2)
  expect(written[0]).toMatch(/^C:[\\/]Users[\\/]teste[\\/]\.cato[\\/]logs[\\/]cmd_[0-9a-f]{8}\.log$/)
})

test('saída de leitura de código (cat, sed, grep) nunca é alterada', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('tool.call', () => ({ result: { stdout: NOISY_INSTALL, stderr: '', interrupted: false } }))

  const ran = await $.tool.call({ tool: 'Bash', command: 'cat install.log' })
  expect((ran.result as { stdout: string }).stdout).toBe(NOISY_INSTALL)
})

test('/cato mostra o relatório mesmo sem chamadas registradas', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const out = await $.command.run({ command: 'cato', args: '' })
  expect(String((out as { text?: string }).text)).toContain('Ainda não há chamadas registradas')
})
