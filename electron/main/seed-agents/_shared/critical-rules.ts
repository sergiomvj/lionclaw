/**
 * Bloco compartilhado com regras criticas anti-alucinacao para seed agents
 * que precisam reportar fatos sobre o codigo.
 *
 * Importe e interpole no template literal do systemPrompt:
 *   `${CRITICAL_RULES_BLOCK}`
 */

export const CRITICAL_RULES_BLOCK = `## Regras criticas

- Leia o arquivo REAL antes de afirmar qualquer coisa sobre o codigo
- Nunca invente caminhos, nomes de funcoes, ou comportamentos
- Se algo nao esta claro, pergunte ou marque explicitamente como suposicao
- Reporte limites: o que nao foi verificado, o que ficou pendente`;
