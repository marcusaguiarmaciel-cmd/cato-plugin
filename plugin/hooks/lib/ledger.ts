// Ledger de custo: um registro por dia (fuso local), somado ao vivo pelo turn.step e pelo import do histórico.

export type Day = {
  calls: number
  cost: number
  read: number
  write: number
  output: number
  ctxSum: number
  maxCtx: number
  missIdle: number
  missIdleCost: number
  missModel: number
  missModelCost: number
  missOther: number
  missOtherCost: number
  // Primeira chamada depois de uma compactação: reescreve o cache por design, não é miss
  rebuilds: number
  rebuildCost: number
  // Chamadas de modelo sem preço conhecido: contadas, mas fora do custo
  unpriced: number
  // Subagentes: custo à parte do da conversa principal (que segue em `cost`)
  subCalls: number
  subCost: number
  subMisses: number
  subMissCost: number
  // Custo da conversa principal por faixa de contexto: < 100k, 100–250k, 250–400k, > 400k
  band0: number
  band1: number
  band2: number
  band3: number
  compressions: number
  compressedTokens: number
  blockedReads: number
  guardHolds: number
  // Esqueleto em leitura grande (opção readGuard): negadas e segundas tentativas liberadas
  readGuardDenies: number
  readGuardBypass: number
  // Tokens que deixaram de entrar no contexto (estimativa por caracteres), por intervenção
  blockedTokens: number
  readGuardTokens: number
  sandboxed: number
  sandboxTokens: number
  masks: number
  maskedTokens: number
  // Cache aquecido em pausas (opção warmCache): chamadas feitas, quanto custaram e a reescrita que evitaram
  warms: number
  warmCost: number
  warmSaved: number
}

export type Ledger = { days: Record<string, Day> }

export const emptyDay = (): Day => ({
  calls: 0, cost: 0, read: 0, write: 0, output: 0, ctxSum: 0, maxCtx: 0, missIdle: 0, missIdleCost: 0,
  missModel: 0, missModelCost: 0, missOther: 0, missOtherCost: 0, rebuilds: 0, rebuildCost: 0, unpriced: 0,
  subCalls: 0, subCost: 0, subMisses: 0, subMissCost: 0, band0: 0, band1: 0, band2: 0, band3: 0,
  compressions: 0, compressedTokens: 0, blockedReads: 0, guardHolds: 0, readGuardDenies: 0, readGuardBypass: 0,
  blockedTokens: 0, readGuardTokens: 0, sandboxed: 0, sandboxTokens: 0, masks: 0, maskedTokens: 0,
  warms: 0, warmCost: 0, warmSaved: 0,
})

// Dia no fuso local: em UTC o "hoje" do Brasil viraria às 21h
export const dayKey = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Início (00:00 local) do dia `key` (AAAA-MM-DD), em ms. */
export const dayStart = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

/** Soma `b` em `a` (campos ausentes de registros antigos contam como 0; `maxCtx` é o maior). */
export function addDay(a: Day, b: Partial<Day> | undefined): Day {
  if (!b) return a
  for (const k of Object.keys(a) as (keyof Day)[]) {
    a[k] = k === 'maxCtx' ? Math.max(a[k], b[k] ?? 0) : a[k] + (b[k] ?? 0)
  }
  return a
}
