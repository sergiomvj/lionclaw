/**
 * Bloco de restricoes Bash para agents que IMPLEMENTAM codigo (Coder/Evaluator
 * do Harness). Diferente do GIT_RESTRICTIONS_BLOCK puro, este bloco PERMITE
 * comandos de validacao (typecheck, lint, build, test) E git read-only, mas
 * proibe operacoes destrutivas (push, commit, rm -rf, --force, etc).
 *
 * Use em agents que precisam rodar `npm run typecheck`, `npx tsc`, `npm test`
 * sem perder a regra de nao alterar git.
 *
 * Importe e interpole no template literal do systemPrompt:
 *   `${BASH_VALIDATION_BLOCK}`
 */

export const BASH_VALIDATION_BLOCK = `## Restricoes Bash (validacao + git read-only)

PERMITIDO (validacao de codigo):
- npm run typecheck, npx tsc, npx tsc --noEmit
- npm run lint, npx eslint
- npm run build (sem deploy)
- npm run test, npx vitest, npx jest
- node --check, node <script-de-teste>
- ls, cat, find (leitura)

PERMITIDO (git read-only):
- git log, git log --all, git log -- <path>
- git show <ref>, git show <ref>:<path>
- git diff, git diff <ref>
- git ls-files, git status, git branch -a, git remote -v, git rev-parse

PROIBIDO (destrutivo / publica mudanca):
- git push, git commit, git add, git rm, git mv
- git reset --hard, git rebase, git checkout (que muda arquivos), git clean
- Qualquer flag --force / -f / --hard
- rm -rf, rmdir, mv (mover/sobrescrever arquivos do projeto)
- npm publish, npm deploy, qualquer comando que envia codigo pra fora
- curl/wget pra URLs externas (exceto registries oficiais via npm)
- Comandos com sudo
- Modificar configuracoes globais (~/.gitconfig, /etc/*)

Para CRIAR/EDITAR arquivos do projeto, use Write/Edit (nao Bash).`;
