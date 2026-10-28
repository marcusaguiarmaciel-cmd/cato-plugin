---
name: cato-efficiency
description: Regras do CATO para economizar tokens ao navegar e ler código. Use ao explorar um repositório, ler arquivos grandes ou quando o contexto da conversa já está grande.
---

# Eficiência de tokens com o CATO

O custo de cada turno é o contexto inteiro relido. O que entra no contexto fica lá até /compact ou /clear.

1. **Leitura cirúrgica:** em arquivos com mais de 300 linhas, use `Read` com `offset` e `limit`, ou `mcp__cato__read_symbol` para uma classe, função ou `Classe.metodo`.
2. **Mapa antes de explorar:** `mcp__cato__repo_map` (com `focus`) dá os arquivos mais centrais e os intervalos `[L<início>-L<fim>]` das declarações. Use esses números no próximo `Read`.
3. **Não reler:** não leia de novo um arquivo que já está no contexto, a menos que tenha mudado.
4. **Buscas amplas num subagente:** delegue ao `cato-explorer` quando precisar procurar em muitos arquivos desconhecidos; só a conclusão volta para a conversa.
5. **Saídas grandes:** saídas comprimidas pelo CATO trazem `#cmd_xxxxxxxx`, e respostas MCP grandes trazem `#sbx_xxxxxxxx`. Busque nelas com `mcp__cato__search_sandbox` em vez de rodar o comando de novo.
6. **Respostas concisas:** não reimprima código que já foi escrito com Edit ou Write; cite `arquivo:linha`.
7. **Custo:** `/cato` mostra o custo real registrado, os cache misses e o que mais economiza no seu uso.
