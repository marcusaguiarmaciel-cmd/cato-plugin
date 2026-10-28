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
| Ferramentas | `mcp__cato__repo_map`, `read_symbol`, `search_sandbox`, `cost_report` |
| Custo real | `/cato [dias]`: custo por chamada desde a instalação, cache misses por causa e recomendações |

As opções ficam no `/plugin`, na configuração do CATO.

## Desenvolvimento

```bash
claude plugin validate plugin
claude plugin test plugin
```

## Licença

[MIT com Commons Clause (Não Comercial)](LICENSE) — Livre para usar, modificar e publicar versões próprias sem fins lucrativos; a venda ou comercialização é proibida sem autorização.
