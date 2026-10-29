# CATO: Claude Adaptive Token Optimizer

[![XERJ Corpus Hub contributor](https://hub.xerj.org/contributors/marcusaguiarmaciel-cmd/badge.svg)](https://hub.xerj.org/contributors/marcusaguiarmaciel-cmd)

[English](README.md)

Plugin para o Claude Code que reduz o custo de tokens com controle de contexto e de cache de prompts, compactação automática, compressão de saídas volumosas e navegação de código eficiente. Roda inteiramente dentro do Claude Code, sem Python e sem processos externos por hook, e se integra a Serena, Graphify, ast-grep e GitHub MCP.

## Instalação

Requer Claude Code **2.1.290 ou mais novo**.

```
/plugin install cato --marketplace marcusaguiarmaciel-cmd/cato-plugin
```


## Idioma

Relatórios, avisos e a linha de status saem em **inglês, português ou espanhol**. O CATO escolhe o idioma nesta ordem:

1. A opção `language` nas configurações do CATO (`/plugin`): `auto` (padrão), `en`, `pt` ou `es`.
2. A configuração `language` do Claude Code (por exemplo `"language": "portuguese"` no `settings.json`).
3. O idioma do sistema (`LC_ALL`, `LC_MESSAGES`, `LANG` ou o locale do sistema operacional).
4. Inglês. Um idioma configurado que o CATO não suporta também cai no inglês.

O que só o modelo lê (negações, rodapés de compressão, descrições de ferramentas, a skill) fica sempre em inglês: custa menos tokens e funciona com a conversa em qualquer idioma. O `/cato-doctor` mostra qual idioma está em uso e de onde ele veio.

## Comandos

| Comando | O que mostra |
|---|---|
| `/cato [dias]` | Custo real por período, cache misses por causa, custo por tamanho de contexto, tokens economizados por intervenção (incluindo o RTK via `rtk gain`) e recomendações. Padrão: 30 dias |
| `/cato-import` | Soma as sessões anteriores à instalação, lidas dos transcripts, sem contar nada duas vezes |
| `/cato-doctor` | Diagnóstico só de leitura: idioma, resto da versão Python, autocompactação em dobro, integrações, `CLAUDE.md` acima de 200 linhas, MCPs demais, `opusplan` e TTLs divergentes |
| `/cato-experimental [ligar\|desligar\|padrão]` | Mostra ou liga e desliga os recursos experimentais |

`/cato importar`, `/cato doctor` e `/cato experimental …` também funcionam, assim como as palavras em inglês e espanhol (`on`, `off`, `default`, `activar`, `desactivar`, `predeterminado`).

## O que faz

| Recurso | Como |
|---|---|
| Guard de contexto/cache | Avisa por faixa de contexto e segura **uma vez** o prompt quando o cache expirou e reescrevê-lo custaria ≥ `guardBlockUsd` |
| Autocompactação | Compacta antes do prompt ao passar de `autoCompactPercent` % da janela |
| Instruções de compactação | Quando ninguém deu instruções (autocompactação, `/compact` sem texto), o resumo guarda objetivo, decisões, arquivos alterados, erros abertos e próximos passos, sem saídas brutas (`compactInstructions`; o texto do seu `/compact` prevalece) |
| Troca de modelo | Com o cache quente, avisa quanto custa reler a conversa no novo modelo (inclui o seletor do app, `opusplan` e skills com outro modelo); nunca segura o prompt |
| Status de custo | Contexto, custo do próximo turno e minutos até o cache expirar (convive com a sua `statusLine`) |
| Leituras pesadas | Nega Read/Grep/Glob em lockfiles, `*.min.*` e em `node_modules`, builds e venvs **só quando o git os ignora** (um `src/build/` versionado é lido normalmente). Repetir a mesma chamada, ou citar o caminho no seu prompt, libera |
| Sandbox MCP | Respostas acima de `sandboxMinTokens` (6.000) viram um sandbox pesquisável que mostra o começo e o fim; repetir a mesma chamada traz a resposta inteira. Ferramentas do app, do terminal, de navegador e do próprio CATO, respostas que o modelo já limitou (`limit`, `perPage`, `fields`…) e ferramentas que casam com `sandboxSkip` chegam sempre inteiras |
| Guard entre reloads | Horário, modelo e contexto da última chamada ficam guardados por sessão no store do CATO: o guard de cache continua valendo depois de um reload do plugin ou de reabrir o app |
| Custo fixo | `structural_search` e `graph_query` só aparecem quando existem ast-grep e Graphify; as descrições das ferramentas são curtas; o `cato-explorer` roda no Haiku sem `CLAUDE.md`. O `/cato-doctor` mostra o tamanho medido das descrições de ferramentas e dos lembretes injetados |
| Compressão de saídas | Testes, linters, instalações e builds no Bash/PowerShell; log bruto em `~/.cato/logs`. Falhas têm prioridade: quando passam do limite, a saída diz quantas linhas de erro ficaram de fora e como buscá-las no log |
| Sintaxe | JSON sempre; `.py` só se houver Python na máquina |
| Pós-compactação | `git diff --stat` devolvido ao modelo no próximo prompt (branch e status o Claude Code já relê) |
| Forks | Pede um subagente com contexto limpo |
| Ferramentas | `mcp__cato__repo_map`, `read_symbol`, `structural_search`, `graph_query`, `search_sandbox`, `cost_report` |
| Import do histórico | Arquivos acima de 4 MiB passam pelo awk (no Windows, o do Git for Windows, mesmo fora do PATH) ou, sem awk, pelo PowerShell; leituras interrompidas são retomadas na próxima execução |
| Experimentais (desligados) | `readGuard`: o Read inteiro de código acima de 60 KB recebe antes o esqueleto, e pedir de novo libera. `maskColdCompact`: com o cache expirado, resultados de ferramenta antigos e grandes viram uma linha antes do resumo. `warmCache`: com contexto grande e a sessão parada, uma chamada mínima 3 minutos antes de o cache expirar o mantém quente (no máximo 2 por pausa); o `/cato` mostra quanto custou e quanto evitou |

As opções ficam no `/plugin`, na configuração do CATO.

### Limites conhecidos

- O custo em dólar é preço de lista; na assinatura, mede o consumo do plano, não uma fatura.
- O TTL das escritas ao vivo vem das opções (`cacheTtlMinutes`, `subagentCacheTtlMinutes`): a API de mods não separa escritas de 5 min e de 1 h. O import usa o valor exato do transcript. Confira com `/cato-doctor`.
- Trocas de fast mode e de effort (fora dos modelos 5.5) também invalidam o cache, mas a API de mods não as expõe: aparecem como "outras".
- O import só conta chamadas anteriores ao primeiro dia registrado ao vivo; a parte desse dia anterior à instalação fica de fora.

## Integrações

Todas são detectadas sozinhas: sem a ferramenta instalada, nada muda.

| Ferramenta | O que o CATO faz com ela |
|---|---|
| **Serena MCP** | Aplica um limite de resposta (`serenaMaxAnswerChars`, padrão 20.000 caracteres) às ferramentas de leitura quando o modelo não pede um; nega leituras pesadas por `relative_path`; checa a sintaxe de `.json`/`.py` depois das edições da Serena; não manda as respostas dela para o sandbox, porque já vêm localizadas |
| **Graphify** | `repo_map` soma as relações de `graphify-out/graph.json` ao ranking; a ferramenta `mcp__cato__graph_query` consulta o grafo sem carregá-lo; a leitura do `graph.json` e do cache é negada em favor do `GRAPH_REPORT.md` |
| **ast-grep** | A ferramenta `mcp__cato__structural_search` (busca pela árvore sintática, resultado `arquivo:L<início>-L<fim>` compacto); `ast-grep ... --json` no Bash vira uma linha por casamento; o `find_code` do MCP do ast-grep recebe `max_results` (`astGrepMaxResults`, padrão 60). É encontrado mesmo fora do PATH quando instalado com `npm i -g @ast-grep/cli` ou `cargo install ast-grep` |
| **GitHub MCP** | Tira do JSON os campos de API (`*_url`, `node_id`, avatares, usuário completo vira só o login, labels viram nomes) e os diffs de lockfiles (`compactGithub`); nega `get_file_contents` de lockfiles; o que continuar grande vai para o sandbox com dicas de `fields`/`perPage` |

A skill `cato-efficiency` e o agente `cato-explorer` dizem ao modelo qual ferramenta usar primeiro quando cada uma está disponível.

## Desenvolvimento

```bash
claude plugin validate plugin
claude plugin test plugin
```

## Licença

[MIT com Commons Clause (Não Comercial)](LICENSE) — Livre para usar, modificar e publicar versões próprias sem fins lucrativos; a venda ou comercialização é proibida sem autorização.
