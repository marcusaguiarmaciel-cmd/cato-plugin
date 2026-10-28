# CATO: Claude Adaptive Token Optimizer

Plugin para o Claude Code que reduz o custo de tokens com controle de contexto e de cache de prompts, compactação automática, compressão de saídas volumosas e navegação de código eficiente. Roda inteiramente dentro do Claude Code, sem Python e sem processos externos por hook, e se integra a Serena, Graphify, ast-grep e GitHub MCP.

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
| Instruções de compactação | Quando ninguém deu instruções (autocompactação, `/compact` sem texto), o resumo guarda objetivo, decisões, arquivos alterados, erros abertos e próximos passos, sem saídas brutas (`compactInstructions`; o texto do seu `/compact` prevalece) |
| Troca de modelo | Com o cache quente, avisa quanto custa reler a conversa no novo modelo (inclui seletor do app, `opusplan` e skills com outro modelo); nunca segura o prompt |
| Status de custo | Contexto, custo do próximo turno e minutos até o cache expirar (convive com a sua `statusLine`) |
| Leituras pesadas | Nega Read/Grep/Glob em `node_modules`, builds, venvs, lockfiles e `*.min.*` |
| Compressão de saídas | Testes, linters, instalações e builds no Bash/PowerShell; log bruto em `~/.cato/logs`. Falhas têm prioridade: quando passam do limite, a saída diz quantas linhas de erro ficaram de fora e como buscá-las no log |
| Sintaxe | JSON sempre; `.py` só se houver Python na máquina |
| Pós-compactação | `git diff --stat` devolvido ao modelo no próximo prompt (branch e status o Claude Code já relê) |
| Forks | Pede um subagente com contexto limpo |
| Ferramentas | `mcp__cato__repo_map`, `read_symbol`, `structural_search`, `graph_query`, `search_sandbox`, `cost_report` |
| Custo real | `/cato [dias]`: custo por chamada, subagentes à parte, custo por faixa de contexto, cache misses por causa (reconstruções após compactar não contam), tokens gastos e tokens economizados por intervenção (com o valor estimado em dólar) e recomendações |
| Histórico | `/cato importar` (ou `/cato-importar`): soma as sessões anteriores à instalação a partir dos transcripts, sem contar nada duas vezes. Arquivos acima de 4 MiB passam por awk (no Windows, o do Git for Windows mesmo fora do PATH) ou, sem awk, pelo PowerShell; leituras interrompidas são retomadas na próxima execução |
| Diagnóstico | `/cato doctor` (ou `/cato-doctor`): só leitura; resto da versão Python, autocompactação em dobro, integrações, `CLAUDE.md` acima de 200 linhas, MCPs demais, `opusplan` e TTLs divergentes |
| Experimentais (desligados) | `/cato experimental ligar` (ou `/cato-experimental ligar`) liga os dois (`desligar` volta; sem argumento mostra o estado). `readGuard`: Read inteiro de código acima de 60 KB recebe antes o esqueleto, e a segunda tentativa passa. `maskColdCompact`: com o cache expirado, resultados de ferramenta antigos e grandes viram uma linha antes do resumo |

As opções ficam no `/plugin`, na configuração do CATO.

### Limites conhecidos

- O custo em dólar é preço de lista; na assinatura, mede o consumo do plano, não uma fatura.
- O TTL das escritas ao vivo vem das opções (`cacheTtlMinutes`, `subagentCacheTtlMinutes`): a API de mods não separa escritas de 5 min e de 1 h. O import usa o valor exato do transcript. Confira com `/cato doctor`.
- Trocas de fast mode e de effort (fora dos modelos 5.5) também invalidam o cache, mas a API de mods não as expõe: aparecem como "outras".
- O import só conta chamadas anteriores ao primeiro dia registrado ao vivo; a parte desse dia anterior à instalação fica de fora.

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
