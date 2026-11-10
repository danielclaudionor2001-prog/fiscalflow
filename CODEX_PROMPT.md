# Prompt inicial para o Codex

Leia primeiro `AGENTS.md`, `README.md` e `docs/ARCHITECTURE.md`.

Quero que você assuma o papel de engenheiro full-stack sênior e desenvolva o Fiscal Floow de forma incremental, mantendo a arquitetura multi-tenant segura.

**Primeira missão: deixar o repositório executável localmente.**
1. Inspecione todos os arquivos existentes e identifique inconsistências.
2. Ajuste o monorepo npm workspaces, scripts de desenvolvimento, build e typecheck.
3. Configure Docker Compose para PostgreSQL e Redis.
4. Garanta que API e frontend iniciem com instruções claras.
5. Configure Prisma e uma rota de health check que verifique a API; não exponha segredos.
6. Adicione testes básicos e `.gitignore`.
7. Não implemente ainda emissão real de NFS-e nem invente endpoints oficiais.
8. Ao terminar, liste arquivos alterados, comandos executados, resultados e próximo passo.

Depois da primeira missão, aguarde minha validação antes de avançar para autenticação e CRUD.
