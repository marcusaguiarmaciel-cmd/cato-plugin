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

export function priceFor(model: string): ModelPrice {
  const id = (model || '').toLowerCase()
  const match = Object.keys(PRICES)
    .filter(key => id.startsWith(key))
    .sort((a, b) => b.length - a.length)[0]
  return PRICES[match ?? 'claude-opus-5']
}

export type StepUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** Custo de uma chamada de API; as escritas de cache usam o TTL configurado (1h na assinatura, 5 min na API). */
export function usageCost(model: string, usage: StepUsage, ttlMinutes: number): number {
  const p = priceFor(model)
  const write = ttlMinutes >= 60 ? p.write1h : p.write5m
  return (
    (usage.input_tokens * p.input +
      usage.cache_creation_input_tokens * write +
      usage.cache_read_input_tokens * p.read +
      usage.output_tokens * p.output) /
    1e6
  )
}

export function contextTokens(usage: StepUsage): number {
  return usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
}

export const usd = (value: number, digits = 2): string => `$${value.toFixed(digits)}`
