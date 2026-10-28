// Mascaramento de observações antes de compactar (opção maskColdCompact): resultados de ferramenta antigos e
// grandes viram uma linha antes de o resumidor ler a conversa. Só vale a pena com o cache frio: com o cache
// quente o resumidor lê o prefixo do cache, e mudar mensagens o faria reler tudo a preço cheio.
// Base: "The Complexity Trap" (JetBrains, NeurIPS 2025 DL4Code): mascarar observações antigas corta o custo
// pela metade com a mesma taxa de acerto da sumarização por LLM.

import type { SessionMessage } from 'claude-code'

export function maskOldToolResults(
  messages: readonly SessionMessage[],
  keepUserMessages: number,
  minChars: number,
): { messages: SessionMessage[]; masked: number } {
  // As últimas `keepUserMessages` mensagens do usuário (e tudo depois delas) ficam intactas
  let users = 0
  let cut = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    users += 1
    if (users === keepUserMessages) {
      cut = i
      break
    }
  }
  if (cut <= 0) return { messages: [...messages], masked: 0 }

  const toolNames = new Map<string, string>()
  for (const message of messages) for (const use of message.toolUses ?? []) toolNames.set(use.tool_use_id, use.tool)

  let masked = 0
  const out = messages.map((message, i): SessionMessage => {
    const results = message.toolResults
    if (i >= cut || message.role !== 'user' || !results?.some(r => (r.text ?? '').length > minChars)) return message
    const toolResults = results.map(r => {
      const length = (r.text ?? '').length
      if (length <= minChars) return r
      masked += 1
      // Mesmo tool_use_id e isError: o par tool_use/tool_result continua casado
      return {
        tool_use_id: r.tool_use_id,
        isError: r.isError,
        text: `[resultado de ${toolNames.get(r.tool_use_id) ?? 'ferramenta'} omitido pelo CATO antes do resumo: ${length} caracteres]`,
      }
    })
    // Sem o handle, o engine lê a mensagem como construída aqui (com os resultados mascarados)
    const { handle: _handle, ...rest } = message
    return { ...rest, toolResults }
  })
  return { messages: out, masked }
}
