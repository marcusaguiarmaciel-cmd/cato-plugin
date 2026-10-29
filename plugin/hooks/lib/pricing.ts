// Tabela oficial de preços da API (USD por milhão de tokens), out/2026.
// Fonte: https://platform.claude.com/docs/en/about-claude/pricing

export type ModelPrice = {
  input: number
  write5m: number
  write1h: number
  read: number
  output: number
}

const legacy = (input: number, output: number): ModelPrice => ({
  input,
  write5m: input * 1.25,
  write1h: input * 2,
  read: input * 0.1,
  output,
})

// Prefixo do id do modelo -> preço; vale o prefixo mais longo que casar
const PRICES: Record<string, ModelPrice> = {
  'claude-opus-5': { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 },
  'claude-sonnet-5': { input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 },
  'claude-haiku-5': { input: 0.1, write5m: 0.125, write1h: 0.2, read: 0.01, output: 0.5 },
  'claude-fable-5': { input: 4, write5m: 5, write1h: 8, read: 0.1, output: 20 },
  'claude-opus-4': legacy(5, 25),
  'claude-sonnet-4': legacy(3, 15),
  'claude-haiku-4': legacy(1, 5),
}

const ALIASES = ['opus', 'sonnet', 'haiku', 'fable']

/** Id sem o sufixo de janela (`[1m]`) e em minúsculas; aliases (`opus`) viram o prefixo da família. */
function normalizeModel(model: string): string {
  const id = (model || '').toLowerCase().replace(/\[[^\]]*\]$/, '').trim()
  return ALIASES.includes(id) ? `claude-${id}-` : id
}

/** Preço do modelo, ou null quando o id não é de um modelo conhecido (o custo não é inventado). */
export function priceFor(model: string): ModelPrice | null {
  const id = normalizeModel(model)
  const keys = Object.keys(PRICES)
  // Alias (`claude-opus-`): a geração mais nova da família; id completo: o prefixo mais longo que casar
  const match = id.endsWith('-')
    ? keys.filter(key => key.startsWith(id)).sort().reverse()[0]
    : keys.filter(key => id.startsWith(key)).sort((a, b) => b.length - a.length)[0]
  return match ? PRICES[match] : null
}

/**
 * Se dois nomes de modelo são o mesmo modelo para o cache: true, false, ou null quando não dá para saber
 * (vazio, `opusplan`, `default`). Um alias (`opus`) casa com qualquer id da família (`claude-opus-5-5`).
 */
export function sameModel(a: string, b: string): boolean | null {
  const x = normalizeModel(a)
  const y = normalizeModel(b)
  if (!x || !y) return null
  const isAlias = (id: string) => ALIASES.some(alias => id === `claude-${alias}-`)
  const isKnown = (id: string) => isAlias(id) || id.startsWith('claude-')
  if (!isKnown(x) || !isKnown(y)) return null
  if (isAlias(x) || isAlias(y)) return isAlias(x) ? y.startsWith(x) : x.startsWith(y)
  return x === y
}

export type StepUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/**
 * Custo de uma chamada de API, ou null para modelo sem preço conhecido. As escritas de cache usam o TTL de
 * quem fez a chamada: a conversa principal tem 1h na assinatura e 5 min na API; subagentes, 5 min.
 */
export function usageCost(model: string, usage: StepUsage, ttlMinutes: number): number | null {
  const p = priceFor(model)
  if (!p) return null
  const write = ttlMinutes >= 60 ? p.write1h : p.write5m
  return (
    ((usage.input_tokens ?? 0) * p.input +
      (usage.cache_creation_input_tokens ?? 0) * write +
      (usage.cache_read_input_tokens ?? 0) * p.read +
      (usage.output_tokens ?? 0) * p.output) /
    1e6
  )
}

export function contextTokens(usage: StepUsage): number {
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
}

/** Faixa de contexto de uma chamada: 0 (<100k), 1 (100–250k), 2 (250–400k), 3 (>400k). */
export function contextBand(tokens: number): 0 | 1 | 2 | 3 {
  return tokens < 100_000 ? 0 : tokens < 250_000 ? 1 : tokens < 400_000 ? 2 : 3
}

export const BAND_LABELS = ['< 100k', '100–250k', '250–400k', '> 400k'] as const
