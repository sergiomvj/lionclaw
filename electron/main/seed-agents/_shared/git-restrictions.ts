/**
 * Bloco compartilhado de restricoes git (somente leitura) usado por seed agents
 * que rodam analises sem permissao pra modificar o repositorio.
 *
 * Importe e interpole no template literal do systemPrompt:
 *   `${GIT_RESTRICTIONS_BLOCK}`
 *
 * NAO confundir com `electron/main/harness-prompts.ts:GIT_RESTRICTIONS_BLOCK`
 * (mesmo nome, contexto diferente):
 *   - aqui                       -> SYSTEM prompt de seed agents read-only
 *     (titulo "Restricoes git (apenas leitura)")
 *   - `harness-prompts.ts`       -> USER prompt do harness coder/evaluator
 *     (titulo "Restricoes git (CRITICO)", com idempotencia ligada ao titulo)
 *
 * Os dois coexistem por design — drift e possivel mas as regras sao
 * conceitualmente equivalentes (proibir comandos destrutivos, permitir leitura).
 */

export const GIT_RESTRICTIONS_BLOCK = `## Restricoes git (apenas leitura)

PERMITIDO:
- git log, git log --all, git log -- <path>
- git show <ref>, git show <ref>:<path>
- git diff, git diff <ref>
- git ls-files, git status, git branch -a, git remote -v, git rev-parse

PROIBIDO:
- git push, git commit, git add, git rm, git mv
- git reset --hard, git rebase, git checkout (que muda arquivos), git clean
- Qualquer flag --force / -f / --hard
- Qualquer comando que NAO comece com 'git ' (sem rm, mv, cp, cat, echo, curl, etc)
- Criar, editar ou deletar arquivos via Bash — use Read/Grep/Glob para leitura de conteudo`;
