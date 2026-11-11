# Fiscal Floow

SaaS multiempresa para gestão e emissão de NFS-e Nacional. O painel exige autenticação e permite gerenciar organizações, clientes, serviços, notas avulsas, recorrências e certificados por empresa. O painel prepara e assina DPS de produção restrita. O envio de teste pode ser habilitado por configuração.

## Requisitos

- Node.js 22.18+ na linha 22 ou Node.js 24 LTS
- npm 10+
- Docker Desktop ou Docker Engine com Docker Compose e suporte a `up --wait` para subir PostgreSQL e Redis

## Executar localmente

Na raiz do projeto, use o PowerShell para criar o arquivo de ambiente local se ele ainda não existir.

```powershell
if (!(Test-Path apps/api/.env)) {
  Copy-Item apps/api/.env.example apps/api/.env
}
```

Em Linux ou macOS, use `test -f apps/api/.env || cp apps/api/.env.example apps/api/.env`. O exemplo usa credenciais descartáveis para desenvolvimento. Se trocar a senha, ajuste `POSTGRES_PASSWORD` e a senha em `DATABASE_URL`, usando codificação de URL quando necessário. No PowerShell, use `npm.cmd` nos comandos abaixo se a política de execução bloquear `npm.ps1`.

```sh
npm ci
docker compose --env-file apps/api/.env up --wait
npm run db:generate
npm run db:deploy
```

O Compose publica PostgreSQL em `127.0.0.1:5432` e Redis em `127.0.0.1:6379`, com volumes persistentes e health checks. As credenciais de inicialização do PostgreSQL valem para volumes novos. Para reaproveitar um volume do scaffold, ajuste a URL às credenciais existentes. Se já houver tabelas, faça backup e confira a compatibilidade do schema antes de adotar o histórico de migrações.

Abra dois terminais na raiz e execute `npm run dev:api` em um e `npm run dev:web` no outro. Acesse o painel em `http://127.0.0.1:5173`. Use esse endereço para corresponder ao `WEB_ORIGIN` do exemplo.

## Hospedagem

Para instalar em uma VPS, siga o [passo a passo para a HostGator](docs/HOSPEDAGEM_HOSTGATOR.md).

## Criar o primeiro acesso

Com o banco local iniciado e as migrações aplicadas, use o comando administrativo a seguir com o CNPJ e os dados da empresa de desenvolvimento. A senha é solicitada no terminal sem eco e deve ter de 15 a 128 caracteres.

```sh
npm run auth:provision -- --cnpj 12345678000100 --company "Empresa de desenvolvimento" --email admin@example.test --name "Responsável" --role OWNER
```

Entre no painel com o documento cadastrado, e-mail e senha. O formulário aceita CPF e CNPJ com ou sem máscara. Contas de pessoa física podem ser cadastradas por convite do proprietário da plataforma ou pelo comando administrativo com `--cpf` no lugar de `--cnpj`. Para criar um vínculo em uma organização existente, informe o documento, o e-mail e um papel explícito entre `OWNER`, `ADMIN`, `OPERATOR`, `ACCOUNTANT` e `VIEWER`. Use `--name` quando a identidade for nova. O comando preserva as senhas e os vínculos existentes e exige acesso administrativo ao banco. Em automação, forneça uma única linha de senha pela entrada padrão, por meio do gerenciador de segredos.

Em uma empresa com CNPJ, o proprietário pode ativar **Organização → Acesso com CPF** com a senha atual. O CPF permite entrar nessa empresa com o mesmo e-mail e senha. Quando o CPF e as credenciais correspondem a mais de uma conta, o painel pede a escolha da conta antes de abrir a sessão. O proprietário pode alterar ou desvincular o próprio CPF nessa mesma tela.

Os campos de documento aplicam a máscara de CPF ou CNPJ ao digitar ou colar. As datas completas usam DD/MM/AAAA e o seletor de calendário quando disponível.

Em **Painel → Planilhas**, importe um arquivo Excel `.xlsx` ou CSV UTF-8 de até 5 MB, com os cabeçalhos na primeira linha. Selecione a aba, confira os dados e configure até seis gráficos de contagem, soma ou média por coluna. A leitura e os cálculos acontecem no navegador durante a análise. Valores numéricos em texto seguem o padrão brasileiro.

## Rotas

| Rota | Resultado |
| --- | --- |
| `http://127.0.0.1:3333/api/health` | HTTP 200 se o processo da API estiver respondendo |
| `http://127.0.0.1:3333/api/health/ready` | HTTP 200 se o Prisma conseguir consultar o PostgreSQL ou HTTP 503 se o banco estiver indisponível |
| `POST /api/auth/login` | Recebe `email`, `password` e `organizationDocument` (CPF ou CNPJ). Com mais de uma conta por CPF, retorna HTTP 409 com as opções. Reenvie os dados com `account` igual à chave da opção escolhida. O campo legado `organizationCnpj` segue aceito. |
| `GET, PUT /api/auth/cpf-login` | Exibe o CPF mascarado do proprietário da empresa ou atualiza seu vínculo com confirmação da senha. Envie `cpf: null` para desvincular. |
| `GET /api/auth/session` | Retorna o usuário, a empresa e o papel vigentes ou HTTP 401 |
| `POST /api/auth/logout` | Revoga a sessão atual e remove o cookie |
| `GET /api/auth/audit` | Mostra os últimos 50 eventos de autenticação da empresa da sessão para `OWNER` e `ADMIN` |
| `GET, PATCH, DELETE /api/organizations/current` | Consulta, edita ou arquiva a organização da sessão |
| `POST /api/organizations` | Cria uma empresa e vincula o usuário criador como `OWNER` |
| `GET, POST /api/customers` e `GET, PATCH, DELETE /api/customers/:id` | Consulta e mantém os clientes da empresa |
| `GET, POST /api/services` e `GET, PATCH, DELETE /api/services/:id` | Consulta e mantém os serviços da empresa |
| `GET, POST /api/invoices` | Lista e cria rascunhos de NFS-e da empresa da sessão |
| `GET /api/dashboard/issuance` | Resume a quantidade, o valor total e a distribuição por dia de NFS-e autorizadas da conta da sessão. Aceita `month=AAAA-MM` e usa o mês atual de Brasília por padrão. |
| `PATCH, DELETE /api/invoices/:id` | Edita ou exclui um rascunho da empresa da sessão |
| `GET, POST /api/invoices/:id/dps` | Consulta e prepara a DPS assinada localmente, com a versão do rascunho no `If-Match` |
| `GET, POST /api/invoices/:id/dps/:dpsId/homologation` | Consulta o resultado salvo ou inicia um envio em produção restrita com `confirmTest: true` |
| `POST /api/invoices/:id/dps/:dpsId/homologation/reconcile` | Recupera a situação de uma tentativa pendente na SEFIN de testes |
| `GET /api/invoices/:id/dps/:dpsId/homologation/xml` | Baixa o XML da NFS-e de teste autorizada |
| `GET /api/invoices/activity` | Mostra o histórico de rascunhos para `OWNER` e `ADMIN` |
| `GET /api/reports/drafts` e `GET /api/reports/drafts.csv` | Filtra, totaliza e exporta rascunhos por período |
| `GET, POST /api/schedules` | Lista ou cria recorrências mensais para preparar rascunhos |
| `POST /api/schedules/monthly` | Configura uma nota mensal por cliente e tipo para o dia 1 |
| `PATCH /api/schedules/:id` | Configura o dia, pausa ou reativa a recorrência |
| `GET /api/team` | Lista os membros da empresa para `OWNER` e `ADMIN` |
| `PATCH, DELETE /api/team/:id` | Permite ao proprietário alterar o papel ou revogar o acesso de outro membro |
| `GET, PUT, DELETE /api/certificates` | Consulta a situação do A1 da empresa, cadastra, substitui ou remove o certificado |
| `POST /api/certificates/production-lookup` | Consulta uma NFS-e já emitida pelo CNPJ habilitado, com o A1 cadastrado |
| `POST /api/auth/activate` | Resgata o convite de uso único para criar o vínculo de proprietário de uma empresa |
| `GET, POST /api/platform/companies` | Lista ou cadastra empresas assinantes para o proprietário da plataforma |
| `POST /api/platform/companies/:id/invitation` | Renova um convite pendente |
| `PATCH /api/platform/companies/:id/access` | Suspende ou reativa o acesso da empresa assinante |
| `GET, PUT /api/receiving-account` | Consulta o resumo ou configura a conta de recebimento da empresa |
| `GET, POST /api/boletos` e `PATCH /api/boletos/:id` | Acompanha boletos externos vinculados às notas da empresa |
| `GET, PUT /api/platform/receiving-account` | Configura a conta que recebe as assinaturas do Fiscal Floow |
| `GET, POST /api/platform/companies/:id/boletos` e `PATCH /api/platform/companies/:id/boletos/:boletoId` | Acompanha boletos de assinatura de uma empresa |

O Redis está provisionado para a futura fila. O readiness da API verifica a conectividade com o PostgreSQL. Para parar os serviços e preservar os dados, use `docker compose --env-file apps/api/.env down`.

## Navegação do painel

Na **Visão geral**, use os atalhos para abrir clientes e rascunhos ou iniciar uma nota avulsa, de acordo com as permissões do seu perfil. O menu agrupa as páginas em **Painel**, **Fiscal**, **Cadastros** e **Empresa**. No celular, abra **Menu** para navegar. As listas de clientes, serviços, rascunhos e notas por cliente exibem os registros em cartões nas telas menores.

O painel **Emissões do mês** mostra a quantidade, o valor total e o gráfico diário das NFS-e autorizadas registradas na conta. A seleção começa no mês atual e permite consultar os 11 meses anteriores. Os totais usam a data de autorização no horário de Brasília. Rascunhos, notas canceladas e documentos disponíveis apenas em portais externos ficam fora dos números.

## Cadastros e permissões

Após entrar, abra **Organização**, **Clientes** ou **Serviços** no painel. Use **Nova organização** para cadastrar outra empresa. Para administrá-la, saia e entre com o novo CNPJ e suas credenciais atuais. O cadastro da empresa permite alterar razão social, nome fantasia, inscrição municipal e código IBGE. O CNPJ identifica a empresa desde sua criação.

| Operação | Papéis |
| --- | --- |
| Consultar os cadastros da empresa | Todos os membros |
| Criar ou arquivar uma organização | `OWNER` |
| Editar a organização da sessão | `OWNER`, `ADMIN` |
| Criar e editar clientes e serviços | `OWNER`, `ADMIN`, `OPERATOR` |
| Arquivar clientes e serviços | `OWNER`, `ADMIN` |

Os cadastros arquivados saem das listagens e preservam o histórico. O arquivamento de uma organização encerra suas sessões e bloqueia novos logins nela. O CNPJ da empresa e o documento do cliente continuam reservados após o arquivamento.

As listas de clientes e serviços aceitam `page` e `limit` e retornam `items` e `hasNext`. Envie valores monetários como texto decimal. A API valida o formato cadastral e aceita CNPJ numérico ou alfanumérico. Os códigos fiscais informados são campos cadastrais. [Receita Federal](https://normas.receita.fazenda.gov.br/sijut2consulta/anexoOutros.action?idArquivoBinario=76204) · [Códigos de municípios do IBGE](https://www.ibge.gov.br/explica/codigos-dos-municipios.php)

Em **Rascunhos**, selecione um cliente, informe a descrição e o valor e salve. Um serviço ativo pode preencher a descrição e o valor padrão. Todos os papéis podem consultar. `OWNER`, `ADMIN` e `OPERATOR` podem criar e editar, e `OWNER` e `ADMIN` podem excluir e abrir **Ver histórico**. A exclusão tira o rascunho da lista e preserva o histórico. O `POST /api/invoices` requer um UUID no cabeçalho `Idempotency-Key`. As alterações exigem o `updatedAt` entre aspas no cabeçalho `If-Match` para evitar sobrescrever uma versão mais recente.

Em **Equipe**, proprietários e administradores consultam os membros da empresa. Proprietários podem alterar o papel ou revogar o acesso de outros membros. A alteração encerra as sessões do membro nessa empresa. Novos vínculos são criados com o comando administrativo de provisionamento.

Em **Relatórios**, proprietários, administradores e contadores podem consultar e exportar os rascunhos ativos da empresa. O período usa a data de criação no horário de Brasília e inclui até 366 dias. A exportação CSV aceita até 5.000 registros por período. Os totais representam os valores dos rascunhos.

Em **Rascunhos**, proprietários e administradores podem escolher **Criar recorrência** para usar um rascunho como modelo. A recorrência copia o cliente, o serviço, a descrição e o valor no momento da criação. Em **Recorrências**, é possível alterar o dia, pausar ou reativar. A API verifica os horários a cada minuto enquanto está em execução. O horário programado é 8h de Brasília. Se o dia escolhido ultrapassar o fim do mês, usa o último dia. Se a API estiver desligada na data programada, prepara um único rascunho pendente na retomada. O cliente ou serviço indisponível pausa a recorrência e o motivo aparece no painel. Os registros gerados entram na lista de rascunhos para revisão.

Em **Notas fiscais**, use **Nova nota avulsa** para preparar um rascunho sem recorrência. Em **Configurar nota mensal**, escolha o cliente, o serviço, o valor e o tipo **Mensalidade**, **Modernização** ou **Orçamento**. Também é possível abrir essa configuração a partir da lista de clientes. O rascunho mensal é preparado no dia 1 às 8h de Brasília, e a categoria acompanha o rascunho. Há uma configuração mensal por cliente e tipo. Em **Recorrências**, ajuste o tipo, o serviço, a descrição e o valor, ou pause o agendamento. As categorias são internas ao painel. O código tributário vem dos dados do serviço.

## Notas e PDFs por cliente

Em **Clientes**, escolha **Ver notas** na linha do cliente ou abra o cadastro e clique em **Ver notas do cliente**. A página reúne os registros daquele cliente com data, descrição, valor e situação. Quando houver uma DPS assinada para a versão atual do rascunho, **Baixar PDF de teste** salva uma prévia A4 com a estrutura visual do DANFSe v2.0. A marcação **SEM VALOR FISCAL** aparece em todas as páginas. Os valores apurados só aparecem no DANFSe da nota autorizada.

Quando um registro de NFS-e autorizada tiver uma chave de acesso, o painel exibe a chave e abre a consulta pública do Portal Nacional com ela preenchida. Na consulta, é possível baixar o DANFSe oficial. [Consulta oficial de NFS-e e DANFSe](https://www.gov.br/pt-br/servicos/consultar-nota-fiscal-de-servico-eletronica)

## Gestão comercial

Em **Cadastros → Produtos e estoque**, cadastre o SKU, preço, custo, estoque mínimo e, se quiser, o fornecedor. Use **Estoque** para registrar entradas e saídas e consultar o histórico. O produto começa com saldo zero. Somente proprietários e administradores podem movimentar estoque manualmente ou arquivar produtos.

Em **Comercial**, crie orçamentos e ordens de serviço com itens de produtos e serviços. O orçamento pode virar uma venda. Conclua a ordem de serviço antes de convertê-la. Na tela de detalhes, use **Imprimir / salvar PDF** para exportar o documento comercial.

Na venda, informe o vencimento, a quantidade de parcelas mensais e, se houver, o responsável e o percentual de comissão. A confirmação atualiza o estoque e gera as contas a receber. A comissão vira uma conta a pagar separada. A venda com cliente e itens de um único serviço pode criar um rascunho de NFS-e com o valor desses itens. O rascunho aparece em **Fiscal → Rascunhos**. Revise os dados fiscais antes de preparar a DPS.

Em **Financeiro → Contas e comissões**, proprietários, administradores e contadores podem lançar contas, registrar baixas integrais ou parciais e salvar o comprovante comercial de cada baixa. Proprietários e administradores podem estornar baixas e cancelar contas manuais sem baixas ativas. Para cancelar uma venda confirmada, estorne as baixas vinculadas e revise o rascunho fiscal. O cancelamento repõe o estoque e cancela as contas da venda.

O **Painel gerencial** separa vendas confirmadas de entradas e saídas registradas. A margem exibida usa o custo dos produtos no momento do cadastro da venda. O saldo de caixa considera apenas as baixas do período e o CSV mostra as movimentações diárias. Boletos e notas fiscais continuam com seus fluxos próprios. O módulo comercial gera documentos de gestão e rascunhos de NFS-e.

Depois de atualizar o código, execute `npm run db:generate` e `npm run db:deploy` antes de reiniciar a API.

## Empresas assinantes e boletos

Para habilitar o painel da plataforma, use o provisionamento administrativo com `--platform-owner`, informando o CNPJ e o e-mail de um vínculo `OWNER` já existente. A atribuição vale para aquele vínculo e preserva a senha.

```sh
npm run auth:provision -- --cnpj 12345678000100 --email admin@example.test --role OWNER --platform-owner
```

Em uma instalação hospedada, o administrador pode criar o primeiro proprietário da plataforma com `FISCALFLOW_FIRST_ACCESS`, incluindo `platformOwner: true` no JSON de inicialização. Informe `cnpj`, `company`, `email`, `name`, `tokenHash` (SHA-256 de um código aleatório de 32 bytes em base64url) e `expiresAt` em UTC, com até 48 horas de validade. Use o código no fragmento do link de ativação. O servidor só cria o convite privilegiado se a conta ainda não existir e se não houver outro proprietário ou convite da plataforma. Após a criação, remova a configuração de inicialização. Convites de assinantes gerados no painel criam proprietários de suas próprias empresas.

Em **Plataforma → Empresas assinantes**, cadastre a empresa e copie o link de primeiro acesso para enviar ao responsável. O link vence em 48 horas e permite uma ativação. Quem já tem uma identidade no Fiscal Floow usa sua senha existente. Suspender uma empresa encerra as sessões dela. Depois da reativação, a equipe entra novamente com as próprias credenciais.

Para convidar uma pessoa física, use o CPF no campo **CPF ou CNPJ**. O titular ativa o convite e entra com o CPF cadastrado, o e-mail e a senha. O CPF aparece mascarado nos cadastros. O fluxo de assinatura de DPS com e-CNPJ A1 é destinado às contas cadastradas com CNPJ.

Em **Financeiro → Conta de recebimento**, o proprietário escolhe **Celcoin** ou **Meu banco** e cadastra a conta da empresa. A tela mostra um resumo mascarado. Use **Ver cobrança** em **Rascunhos** ou no histórico de notas do cliente para planejar um boleto com o valor do registro fiscal. Em **Financeiro → Boletos**, filtre a lista e registre a referência do título depois da emissão no banco. **Atrasado** indica que o boleto registrado passou do vencimento no horário de Brasília. **Dar baixa** registra uma confirmação manual após a conferência do crédito no extrato.

As assinaturas usam a conta configurada separadamente em **Plataforma → Conta das assinaturas**. Em **Empresas assinantes → Cobranças**, planeje uma cobrança por competência para a empresa selecionada. O acompanhamento é independente das cobranças que ela faz para os próprios clientes.

O painel acompanha boletos emitidos no banco ou na Celcoin. A emissão e a conciliação em produção dependem da homologação com a instituição de cada empresa. [Registro do boleto no Banco Central](https://www.bcb.gov.br/meubc/faqs/s/boleto)

### Celcoin BaaS em Sandbox

O conector usa a API de Bolepix do produto **cel_banking/BaaS** no Sandbox. Solicite à Celcoin as credenciais desse produto, a conta recebedora e a chave Pix de teste e os dados do pagador de teste. [Credenciais da Celcoin](https://developers.celcoin.com.br/docs/obtendo-acesso-%C3%A0s-apis) · [Emissão de boleto no BaaS](https://developers.celcoin.com.br/docs/criar-uma-cobran%C3%A7a-avulsa)

Em desenvolvimento, aponte `CELCOIN_SANDBOX_CONFIG_FILE` para um arquivo JSON protegido, fora do repositório e legível só pelo serviço. O arquivo contém uma lista de conexões. Cada conexão tem os campos abaixo.

| Campo | Preenchimento |
| --- | --- |
| `organizationCnpj` | CNPJ da organização no Fiscal Floow sem pontuação. Para assinaturas, use o CNPJ da organização em que o proprietário da plataforma entra. |
| `purpose` | `SERVICE` para cobranças da própria empresa ou `SUBSCRIPTION` para assinaturas do Fiscal Floow. |
| `clientId`, `clientSecret` | Credenciais OAuth2 do produto BaaS no Sandbox. |
| `receiver` | Objeto com `account` e `document` da conta recebedora fornecida para testes. |
| `pixKey` | Chave Pix da conta Sandbox, fornecida ou cadastrada para testes. |
| `debtor` | Objeto com `name`, `document`, `city`, `publicArea`, `number`, `neighborhood`, `postalCode` e `state` do pagador fictício. Use documentos e CEP sem pontuação. |

Depois de reiniciar a API, escolha **Celcoin** em **Conta de recebimento** ou **Conta das assinaturas**. Planeje uma cobrança e clique em **Gerar boleto de teste**. A Celcoin recebe um valor fixo de R$ 10,00 e os dados do pagador de teste configurado. Use **Consultar teste Celcoin** para consultar a mesma tentativa, inclusive quando aparecer **Aguardando consulta**. Os dados do cliente e o valor da nota ficam no Fiscal Floow. O teste tem situação própria e o crédito confirmado no Sandbox fica separado da baixa manual do boleto acompanhado. [Consultar boleto emitido](https://developers.celcoin.com.br/docs/consultar-cobranca-avulsa)

## Certificado A1 e preparação da DPS

Para habilitar o cofre, injete `FISCAL_CERTIFICATE_KEY` com uma chave aleatória de 32 bytes em base64url, guardada fora do banco e do repositório. Configure `FISCAL_CERTIFICATE_ROOTS_FILE` com o caminho de um PEM que contenha somente as raízes ICP-Brasil confiáveis usadas pela sua instalação. Preserve a chave entre reinicializações. Uma troca de chave sem migração exige cadastrar novamente o A1. [Raízes oficiais do ITI](https://www.gov.br/iti/pt-br/assuntos/repositorio/repositorio-ac-raiz)

No Render, coloque os PEM públicos em **Environment → Secret Files** e use os caminhos `/etc/secrets/<nome-do-arquivo>` nas variáveis do cofre. Salve a chave e o caminho das raízes na mesma alteração. O serviço web público do Blueprint usa `TRUST_RENDER_PROXY=true` para reconhecer o HTTPS do proxy do Render. Use essa opção quando todas as requisições chegarem pelo proxy da plataforma. Em outras hospedagens, configure os endereços de proxy em `TRUSTED_PROXY_IPS`. [HTTPS no Render](https://render.com/articles/how-to-implement-authentication-and-authorization)

Em **Certificados**, o proprietário cadastra, substitui ou remove o e-CNPJ A1 da empresa. O administrador pode consultar a situação e o vencimento. Exporte o arquivo `.pfx` ou `.p12` protegido por senha. A API usa os intermediários incluídos no arquivo e pode completar a cadeia com um PEM de intermediários públicos configurado em `FISCAL_CERTIFICATE_INTERMEDIATES_FILE`. A validação exige que a cadeia chegue a uma das raízes configuradas. Ela também verifica CNPJ, política A1, validade, finalidade, integridade e correspondência da chave privada. Use HTTPS em produção. A API aceita HTTP somente para o fluxo de desenvolvimento em loopback. A verificação de revogação e o credenciamento devem ser confirmados na homologação. [Atribuição de OIDs da ICP-Brasil](https://www.gov.br/iti/pt-br/assuntos/legislacao/documentos-principais/copy_of_IN152020DOC04.01comanexo.pdf)

Em **Rascunhos**, use **Preparar DPS** para preencher os dados fiscais do cenário de teste, incluindo competência, série e um número ainda disponível. O painel usa os dados do prestador, do cliente e do rascunho, valida o leiaute e assina com o A1 cadastrado. O resultado **DPS assinada localmente** mostra o identificador da declaração. Ela fica armazenada na empresa da sessão. Com `NFSE_HOMOLOGATION_ENABLED=true` e o cofre configurado, o proprietário da empresa pode confirmar **Enviar DPS de teste**. A tela mostra o resultado e permite **Consultar teste na SEFIN** quando a tentativa está pendente. Se a SEFIN autorizar a NFS-e de teste, baixe o XML na mesma tela. O teste fica vinculado à DPS, e a nota continua como rascunho para fins fiscais. [Documentação oficial de produção restrita](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita)

Em **Empresa → Certificados**, o proprietário do CNPJ definido em `NFSE_PRODUCTION_LOOKUP_CNPJ` pode consultar uma nota de produção já emitida pela própria empresa. O painel pede a chave de acesso e devolve número, situação no XML e data de geração. A conexão com a SEFIN de produção aceita exclusivamente `GET /nfse/{chaveAcesso}`. O Fiscal Floow audita o uso do A1 e mantém a emissão em produção desativada. [Manual oficial da API](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/manual-contribuintes-emissor-publico-api-sistema-nacional-nfs-e-v1-2-out2025.pdf)

## Verificar e compilar

```sh
npm run db:validate
npm test
npm run test:db
npm run typecheck
npm run build
npm audit
```

`npm test` cobre saúde, credenciais, validação fiscal e o contrato da SEFIN com respostas sintéticas. `npm run test:db` requer um PostgreSQL descartável com as migrações aplicadas. Ele cobre login, papéis, auditoria, isolamento entre empresas, recorrências e a preparação local com certificados de teste. Os registros de teste são revertidos ou removidos ao final. Para executar a API compilada, use `npm start --workspace @fiscalflow/api`. O build do painel fica em `apps/web/dist`.

Use `npm run db:migrate -- --name nome_da_migracao` ao desenvolver uma alteração no schema. Use `npm run db:deploy` para aplicar migrações já registradas. O Vite encaminha `/api` para a porta local 3333 em desenvolvimento e na prévia.

Ao atualizar um banco com cadastros anteriores, verifique duplicidades de CNPJ entre organizações e de CPF/CNPJ de clientes dentro de cada empresa, desconsiderando máscara e caixa. A migração `2_registrations` preserva os documentos armazenados e exige unicidade do valor normalizado.

Em produção, sirva o painel e encaminhe `/api` na mesma origem HTTPS. Use `NODE_ENV=production`, defina `WEB_ORIGIN` com a origem exata do painel, injete `DATABASE_URL` por um gerenciador de segredos e aplique as migrações em uma etapa separada. Preencha `TRUSTED_PROXY_IPS` apenas com os IPs dos proxies de entrada que sobrescrevem cabeçalhos encaminhados vindos do cliente. Em múltiplas réplicas, aplique também limites de requisições no ingress, pois os limites da API são por instância. O Compose deste projeto usa credenciais e portas de desenvolvimento.

`WEB_ALTERNATE_ORIGIN` pode indicar a origem HTTPS exata de um segundo endereço que serve a mesma aplicação. No Render, ela permite abrir convites pelo endereço `onrender.com` enquanto alguns provedores de internet ainda resolvem o domínio principal para a hospedagem anterior. Cada endereço mantém seu próprio cookie de sessão.

## Arquitetura e sequência

- `apps/web` contém o painel React, Vite e TypeScript.
- `apps/api` contém Express, TypeScript, Prisma e migrações.
- `docs/ARCHITECTURE.md` registra as decisões e os limites da base atual.
- `AGENTS.md` e `CODEX_PROMPT.md` descrevem as regras de trabalho e a sequência das missões.

## NFS-e Nacional em homologação

O comando `npm run nfse:homologacao -- --help` lista as operações de geração, assinatura e validação local da DPS, além de consulta e envio em produção restrita. Consulte [HOMOLOGACAO_NFSE.md](docs/HOMOLOGACAO_NFSE.md) para preencher o modelo, assinar com seu e-CNPJ A1 e seguir o roteiro de homologação.
