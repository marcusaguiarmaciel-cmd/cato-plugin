---
name: cato-efficiency
description: Regras do CATO para economizar tokens ao navegar e ler código, inclusive com Serena, Graphify, ast-grep e GitHub MCP. Use ao explorar um repositório, ler arquivos grandes ou quando o contexto da conversa já está grande.
---

# Eficiência de tokens com o CATO

O custo de cada turno é o contexto inteiro relido. O que entra no contexto fica lá até /compact ou /clear.

## Escolha a ferramenta mais precisa disponível

| Para | Use primeiro | Se não houver |
|---|---|---|
| Panorama do projeto | `graphify-out/GRAPH_REPORT.md` (Graphify) | `mcp__cato__repo_map` |
| Onde um conceito aparece e com o que se liga | `mcp__cato__graph_query` (Graphify) | `mcp__cato__repo_map` com `focus` |
| Ler uma classe/função | `find_symbol` da Serena com `include_body: true` | `mcp__cato__read_symbol` |
| Estrutura de um arquivo | `get_symbols_overview` da Serena | `Read` com `offset`/`limit` nos `[L<início>-L<fim>]` do repo_map |
| Quem usa um símbolo | `find_referencing_symbols` da Serena | `mcp__cato__structural_search` |
| Padrão de código (chamada, decorator, hook) | `mcp__cato__structural_search` (ast-grep) | Grep |
| Texto livre | Grep | — |

## Regras

1. **Leitura cirúrgica:** em arquivos com mais de 300 linhas, nunca leia o arquivo inteiro; use as ferramentas acima ou `Read` com `offset` e `limit`.
2. **Não reler:** não leia de novo um arquivo que já está no contexto, a menos que tenha mudado.
3. **Buscas amplas num subagente:** delegue ao `cato-explorer` quando precisar procurar em muitos arquivos desconhecidos; só a conclusão volta.
4. **Serena:** o CATO aplica um limite de resposta quando você não passa `max_answer_chars`. Se a Serena disser que a resposta passou do limite, restrinja (`relative_path`, `depth`, `include_body: false`) em vez de aumentar o limite.
5. **GitHub MCP:** peça só o necessário: `fields` (sem `body` quando não precisa), `perPage`, `detail: "none"` em `get_commit`, `failed_only`/`tail_lines` em `get_job_logs`. O CATO tira do JSON os campos de API.
6. **Graphify:** não leia `graphify-out/graph.json` (o CATO nega); use o relatório ou o `graph_query`.
7. **Saídas grandes:** saídas comprimidas trazem `#cmd_xxxxxxxx`, e respostas MCP grandes trazem `#sbx_xxxxxxxx`. Busque nelas com `mcp__cato__search_sandbox` em vez de rodar de novo. Quando a saída avisa "⚠ N linhas de erro não mostradas", os erros estão no log: busque o termo da falha antes de concluir qualquer coisa.
8. **Saídas verbosas num subagente:** suíte de testes inteira, logs longos e documentação extensa ficam no contexto do subagente; só o resumo volta.
9. **CLI antes de MCP:** quando existe CLI (`gh`, `aws`, `gcloud`), ela não acrescenta definições de ferramenta ao contexto.
10. **Caminho abandonado:** para descartar uma tentativa, sugira `/rewind` ("Summarize from here"), que volta a um prefixo já em cache; `/compact` é para pausas naturais, e `/clear` para trocar de tarefa (com `/rename` antes, para achar a sessão depois).
11. **Respostas concisas:** não reimprima código que já foi escrito; cite `arquivo:linha`.
12. **Custo:** `/cato` mostra o custo real registrado, os cache misses e o que mais economiza; `/cato doctor` aponta configurações que gastam contexto; `/cato importar` inclui as sessões anteriores à instalação.
