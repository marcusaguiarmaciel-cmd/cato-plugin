# CATO — plugin para Claude Code (sem Python)

Economia de tokens medida, rodando dentro do Claude Code como mod: sem Python e sem processo por hook.

## Instalação

Requer Claude Code **2.1.290 ou mais novo**.

```
/plugin install cato --marketplace marcusaguiarmaciel-cmd/cato-plugin
```


## O que faz

| Recurso | Como |
|---|---|
| Guard de contexto/cache | Avisa por faixa de contexto e segura **uma vez** o prompt quando o cache expirou e reescrevê-lo custaria ≥ `guardBlockUsd` |
| Autocompactação | Compacta antes do prompt ao passar de `autoCompactPercent` % da janela |
| Status de custo | Contexto, custo do próximo turno e minutos até o cache expirar (convive com a sua `statusLine`) |
| Leituras pesadas | Nega Read/Grep/Glob em `node_modules`, builds, venvs, lockfiles e `*.min.*` |
| Compressão de saídas | Testes, linters, instalações e builds no Bash/PowerShell; log bruto em `~/.cato/logs` |
| Sintaxe | JSON sempre; `.py` só se houver Python na máquina |
| Pós-compactação | Estado do Git devolvido ao modelo no próximo prompt |
| Forks | Pede um subagente com contexto limpo |
| Ferramentas | `mcp__cato__repo_map`, `read_symbol`, `structural_search`, `graph_query`, `search_sandbox`, `cost_report` |
| Custo real | `/cato [dias]`: custo por chamada desde a instalação, cache misses por causa e recomendações |

As opções ficam no `/plugin`, na configuração do CATO.

## Integrações

Todas são detectadas sozinhas: sem a ferramenta instalada, nada muda.

| Ferramenta | O que o CATO faz com ela |
|---|---|
| **Serena MCP** | Aplica um limite de resposta (`serenaMaxAnswerChars`, padrão 20.000 caracteres) às ferramentas de leitura quando o modelo não pede um; nega leituras pesadas por `relative_path`; checa a sintaxe de `.json`/`.py` depois das edições da Serena; não manda as respostas dela para o sandbox, porque já vêm localizadas |
| **Graphify** | `repo_map` soma as relações de `graphify-out/graph.json` ao ranking; nova ferramenta `mcp__cato__graph_query` consulta o grafo sem carregá-lo; leitura do `graph.json` e do cache é negada em favor do `GRAPH_REPORT.md` |
| **ast-grep** | Nova ferramenta `mcp__cato__structural_search` (busca pela árvore sintática, resultado `arquivo:L<início>-L<fim>` compacto); `ast-grep ... --json` no Bash vira uma linha por casamento; `find_code` do MCP do ast-grep recebe `max_results` (`astGrepMaxResults`, padrão 60) |
| **GitHub MCP** | Tira do JSON os campos de API (`*_url`, `node_id`, avatares, usuário completo vira só o login, labels viram nomes) e os diffs de lockfiles (`compactGithub`); nega `get_file_contents` de lockfiles; o que continuar grande vai para o sandbox com dicas de `fields`/`perPage` |

A skill `cato-efficiency` e o agente `cato-explorer` dizem ao modelo qual ferramenta usar primeiro quando cada uma está disponível.

## Desenvolvimento

```bash
claude plugin validate plugin
claude plugin test plugin
```

## Licença

[MIT com Commons Clause (Não Comercial)](LICENSE) — Livre para usar, modificar e publicar versões próprias sem fins lucrativos; a venda ou comercialização é proibida sem autorização.
