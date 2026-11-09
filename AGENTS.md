# Instruções para o Codex — FiscalFlow

Você está trabalhando no FiscalFlow, um SaaS multiempresa (multi-tenant) para gestão e emissão de NFS-e no padrão nacional brasileiro.

## Objetivo do produto
Construir uma aplicação comercial segura para várias empresas, com:
- autenticação e controle de acesso;
- organizações/empresas isoladas;
- cadastro de clientes tomadores;
- catálogo de serviços e parâmetros fiscais;
- emissão manual e recorrente de NFS-e;
- consulta, eventos e cancelamento quando permitido;
- histórico, auditoria e relatórios;
- planos e limites de assinatura.

## Regras obrigatórias
1. Não afirme que a emissão fiscal funciona até a integração oficial estar implementada e testada em ambiente de homologação.
2. Não invente endpoints, campos XML, regras tributárias, XSDs ou procedimentos da NFS-e Nacional. Consulte os manuais, esquemas XML e notas técnicas oficiais atuais antes de implementar.
3. Nunca use automação de navegador/raspagem do portal como substituto de integração oficial.
4. Toda tabela operacional deve ter vínculo com `organizationId`, salvo tabelas globais justificadas.
5. Obtenha `organizationId` da sessão autenticada e da associação do usuário. Nunca confie em `organizationId` enviado pelo cliente.
6. Todas as consultas e mutações devem filtrar pelo tenant autorizado. Adicione testes que tentem acessar dados de outra organização.
7. Certificados A1, senhas, tokens e chaves privadas nunca podem ser enviados ao frontend, registrados em logs ou armazenados em texto puro.
8. Antes de aceitar certificado, validar formato, validade e titularidade conforme os requisitos oficiais. Criptografar em repouso com chave externa ao banco.
9. Emissão deve ser idempotente. Em timeout, consultar o estado antes de reenviar para evitar duplicidade.
10. Registrar trilha de auditoria para operações sensíveis.
11. Validar entradas com Zod (ou solução equivalente), tratar erros sem vazar stack trace em produção e aplicar rate limiting.
12. Preferir mudanças pequenas, testáveis e tipadas. Não adicionar dependências sem necessidade.
13. Não colocar segredos reais em `.env`, código, commits ou exemplos. Atualizar `.env.example` com placeholders.
14. Não remover funcionalidades existentes sem explicar e justificar.

## Fluxo de trabalho
- Primeiro leia `README.md` e `docs/ARCHITECTURE.md`.
- Antes de grandes alterações, apresente um plano curto.
- Implemente uma etapa por vez.
- Ao concluir cada etapa, rode testes, lint/typecheck e build disponíveis.
- Corrija erros introduzidos pela alteração.
- Atualize README/documentação e informe exatamente o que foi implementado, o que falta e como executar.

## Prioridade de desenvolvimento
1. Base executável: workspace, Docker Compose, API, web e banco.
2. Autenticação segura e memberships/roles.
3. CRUD de organizações, clientes e serviços com isolamento multi-tenant.
4. Testes automatizados de isolamento e autorização.
5. Camada fiscal desacoplada e homologação NFS-e Nacional.
6. Fila assíncrona, idempotência, retentativas e reconciliação.
7. Certificados e credenciamento.
8. Assinaturas, cobrança, limites e observabilidade.

## Stack pretendida
- Frontend: React, Vite, TypeScript.
- Backend: Node.js, Express, TypeScript.
- Banco: PostgreSQL, Prisma.
- Fila: Redis + BullMQ.
- Validação: Zod.
- Infra local: Docker Compose.

## Definition of Done
Uma tarefa só está concluída quando:
- código compila;
- testes relevantes passam;
- autorização e isolamento multi-tenant foram considerados;
- erros e estados de falha foram tratados;
- documentação foi atualizada;
- nenhuma integração simulada é apresentada como emissão fiscal real.
