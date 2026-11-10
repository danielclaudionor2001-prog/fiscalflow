# Arquitetura Fiscal Floow

## Visão geral
Aplicação SaaS multi-tenant com frontend React, API Node/Express, PostgreSQL/Prisma e processamento assíncrono com Redis/BullMQ.

## Base executável

O npm gerencia os workspaces da API e do painel com um lockfile único. Em desenvolvimento, o Compose fornece PostgreSQL e Redis em interfaces locais. O Prisma mantém o schema e o histórico de migrações. A API valida a configuração na inicialização e expõe sondas separadas para o processo HTTP e a conexão com o PostgreSQL. As sondas usam limitação de requisições em memória por instância. O Redis fica disponível para a etapa de filas.

## Isolamento multi-tenant
Cada organização é um tenant. Usuários pertencem a organizações por `Membership` e possuem papéis. O backend deriva o tenant a partir da sessão autenticada; nunca aceita o tenant arbitrariamente do navegador. Toda query deve ser escopada por organização.

`User` representa uma identidade global e `Organization` é a raiz do tenant. `Membership`, `Customer`, `Service` e `Invoice` têm vínculo obrigatório com a organização. As chaves estrangeiras de tomador e serviço em `Invoice` incluem a organização, impedindo referências cruzadas no PostgreSQL. O arquivamento de cadastros preserva essas referências.

O login verifica a identidade e o vínculo correspondente ao documento solicitado. Uma organização tem um CPF ou um CNPJ. A API normaliza a máscara, preserva a compatibilidade com CNPJs legados e retorna apenas o CPF mascarado nas telas cadastrais. Cada sessão referencia a chave composta de `Membership` e perde acesso quando o vínculo é removido. A API deriva a organização e o papel da associação atual a cada acesso protegido. A consulta de auditoria usa esse escopo e exige `OWNER` ou `ADMIN`.

## Autenticação e sessões

A identidade usa senha derivada com scrypt e salt aleatório. A sessão usa um identificador aleatório de 256 bits e armazena no PostgreSQL apenas o hash SHA-256 do identificador. A aplicação entrega o identificador em um cookie `HttpOnly` e `SameSite=Strict`, com `Secure` e prefixo `__Host-` em produção. A sessão expira após 30 minutos de inatividade ou oito horas no total. Um novo login revoga a sessão apresentada, e logout revoga no banco.

A API exige a origem do painel nas chamadas que alteram estado. O login tem limite por IP, e as respostas de autenticação evitam cache e detalhes sobre falhas internas. Provisionamento, login e revogação explícita registram eventos por empresa junto com a mutação correspondente. O cadastro inicial usa um comando administrativo que cria vínculos sem alterar credenciais existentes.

O CPF usado para entrar em uma empresa pertence ao vínculo do proprietário com aquela empresa. Sua alteração exige a senha atual, tem limite de tentativas e gera auditoria. O login lista contas candidatas somente após validar a senha. Cada escolha é conferida novamente contra os vínculos ativos antes de gerar a sessão. A mudança de papel do proprietário limpa o CPF vinculado.

Proprietários e administradores consultam os membros do tenant. Proprietários podem alterar o papel ou revogar o vínculo de outro membro. A transação bloqueia a organização e reconfirma o papel do ator para preservar pelo menos um proprietário, inclusive em operações concorrentes. Mudanças encerram as sessões do membro apenas na empresa afetada e registram o evento de auditoria.

O comando administrativo pode designar um vínculo `OWNER` como proprietário da plataforma. O painel de assinantes acessa apenas os dados cadastrais, o estado do acesso e as cobranças de assinatura dos tenants gerenciados. A suspensão é distinta do arquivamento e encerra as sessões da organização. A ativação de convidados usa um código aleatório no fragmento da URL. O servidor recebe apenas o hash ao criar o convite e verifica o código apresentado no resgate. A transação consome o convite, cria o vínculo e registra a auditoria. O primeiro convite de proprietário da plataforma pode ser criado pela configuração de inicialização do servidor. Seu privilégio fica associado ao convite persistido e é transferido somente ao vínculo criado no resgate. A inicialização protege contra convites privilegiados duplicados e contra recriação de contas existentes.

## Cadastros

Consultas e mutações de clientes e serviços filtram pela organização da sessão e excluem registros arquivados. Um serviço pode estar inativo no catálogo e continuar disponível para consulta. A rota da organização atual usa o mesmo contexto. O cabeçalho `X-FiscalFlow-Context` funciona como uma asserção adicional no painel e protege abas com uma organização desatualizada. O servidor deriva o escopo exclusivamente da sessão.

### Acompanhamento de boletos

`ReceivingAccount` registra os identificadores bancários por organização e finalidade. As duas finalidades separam o recebimento de serviços do recebimento de assinaturas. O formulário não recebe credenciais bancárias e o número completo da conta não é devolvido pela API. Um `Boleto` de serviço usa uma chave estrangeira composta para a nota e copia dela o valor. Um boleto de assinatura tem a empresa assinante como escopo e usa o cadastro de recebimento da plataforma. O banco exige unicidade por nota ou por empresa e competência. A identificação da conta no histórico é preservada quando o cadastro muda.

O acompanhamento registra títulos externos. A baixa manual depende de um título registrado, e as transições usam atualização condicional para tratar solicitações concorrentes. Os filtros calculam o atraso na data civil de São Paulo. A API registra o ator na auditoria e separa o acesso da plataforma dos dados de cobrança dos clientes de cada empresa. O registro de um boleto não altera a situação da nota fiscal.

O conector Celcoin BaaS usa exclusivamente a origem HTTPS do Sandbox. O servidor seleciona a conexão pelo CNPJ da sessão e pela finalidade da cobrança, com segredos mantidos fora do banco e do frontend. Cada `CelcoinSandboxCharge` referencia o boleto com chave composta do tenant. A API grava um identificador externo único antes de solicitar a emissão, e uma reserva existente é reconciliada por consulta. O resultado só é aplicado se corresponder ao identificador, ao beneficiário, ao vencimento e ao valor do teste. A versão da linha coordena consultas concorrentes. O teste tem um pagador fictício e ciclo de status independente da cobrança acompanhada e do registro fiscal.

Criar uma empresa gera seu vínculo inicial de proprietário na mesma transação. Mutações cadastrais gravam um evento de auditoria com organização, ator, ação e ID do cadastro. O arquivamento da empresa revoga suas sessões na mesma transação. Bloqueios de linha coordenam novas sessões e alterações de catálogo com o arquivamento concorrente.

O painel cria, lista, edita e exclui registros `Invoice` no estado `DRAFT`. Novos vínculos exigem cliente disponível na empresa e serviço ativo, quando informado. A descrição e o valor são gravados no rascunho, e cada mutação fica registrada na auditoria junto com a transação. A restrição única de organização e chave de idempotência coordena criações repetidas e concorrentes. A exclusão grava `discardedAt` para preservar a chave e o histórico. Edição e exclusão conferem `updatedAt` antes da mutação.

Relatórios usam o mesmo escopo de rascunhos ativos e a data de criação no horário de Brasília. Totais e registros paginados vêm do mesmo snapshot do PostgreSQL. O CSV limita o tamanho da exportação e neutraliza campos que poderiam ser interpretados como fórmulas.

O painel mensal de emissões agrega no PostgreSQL apenas registros autorizados da organização da sessão. O período e os dias do gráfico usam `authorizedAt` convertido para `America/Sao_Paulo`. Uma consulta obtém as contagens diárias e os totais a partir do mesmo conjunto de registros e mantém a precisão decimal dos valores.

A preparação mensal usa `InvoiceSchedule` com chaves estrangeiras compostas para o rascunho modelo, o cliente e o serviço. Um agendador na API seleciona até 30 recorrências vencidas a cada minuto. Cada transação bloqueia a organização e a recorrência para criar o rascunho, registrar a ação da automação e avançar a data de forma atômica. Instâncias concorrentes usam `FOR UPDATE SKIP LOCKED` para coordenar a execução. Cliente indisponível ou serviço inativo pausa a recorrência. Essa preparação gera registros `DRAFT`. A fila de emissão fiscal é uma etapa separada.

Uma nota mensal também pode ser configurada sem rascunho modelo. Nesse caso, a chave parcial por organização, cliente e tipo garante uma única configuração de cada tipo e o dia fica fixo em 1. O agendador copia a categoria para o rascunho. Migrações classificam rascunhos anteriores como avulsos e configurações recorrentes anteriores como mensalidades.

### Gestão comercial e caixa

Fornecedores, produtos, movimentos de estoque, pedidos e contas operam no escopo da organização autenticada. Chaves estrangeiras compostas impedem referências cruzadas entre tenants. Os itens guardam nome, quantidade, preço e custo de produto na venda. A conversão preserva o orçamento ou a ordem original e cria uma única venda em aberto. Alterações em pedidos conferem a versão vista no painel.

A confirmação da venda registra o movimento de cada produto, o parcelamento e a comissão em uma transação. O bloqueio por organização coordena as mutações comerciais e o banco impede estoque e saldo negativos. A divisão de parcelas conserva o valor em centavos e ajusta o vencimento para o último dia nos meses curtos. Estornos e cancelamentos preservam a trilha de auditoria. Criação de pedidos, movimentos manuais e baixas usam chaves de idempotência por organização.

Uma venda confirmada com cliente e itens de um único serviço ativo pode gerar um rascunho fiscal vinculado. Produtos ficam fora do valor do rascunho. A ação reutiliza a validação cadastral da NFS-e. O painel de caixa agrega baixas não estornadas por data civil e mantém vendas confirmadas em uma métrica separada.

## Cofre de certificados

O proprietário gerencia um certificado por organização. A importação exige a versão vista no painel para impedir substituições ou remoções concorrentes e grava a auditoria na transação. A API retorna somente situação, versão e datas. A validação do PKCS#12 e a assinatura usam um worker com tempo, memória e concorrência limitados. A chave privada e a senha não são incluídas em respostas nem em auditoria.

O arquivo e a senha são criptografados em conjunto com AES-256-GCM, nonce aleatório e autenticação vinculada à organização e à versão. A chave vem do gerenciador de segredos e não é gravada no PostgreSQL. A confiança é ancorada em raízes configuradas no servidor, e a importação compara o CNPJ do titular ao da sessão. A validação local não consulta listas de revogação. A remoção, a substituição e o arquivamento da empresa retiram a credencial anterior da tabela operacional. O ciclo de vida de cópias e backups segue as regras de retenção da instalação.

## Domínios
- Identity & Access: usuários, sessões, memberships e papéis.
- Organizations: dados cadastrais e configurações.
- Customers: tomadores dos serviços.
- Service Catalog: serviços e códigos fiscais.
- Invoicing: DPS, NFS-e, estados, eventos e idempotência.
- Automation: agendamentos e fila.
- Billing: planos, assinaturas e limites.
- Audit: trilha de ações.
- Fiscal Provider: adaptador para integração oficial nacional.

## Fluxo de emissão pretendido
1. Usuário solicita emissão manual ou execução de agendamento.
2. API valida papel, tenant, tomador, serviço e dados fiscais.
3. Uma transação grava a intenção com chave idempotente.
4. Worker prepara a DPS usando leiaute/XSD oficial vigente.
5. Integração realiza autenticação/assinatura conforme especificação oficial.
6. Serviço transmite para o ambiente adequado.
7. Worker persiste retorno, protocolo, chave, XML e eventos.
8. Em caso de timeout, consulta a situação antes de repetir.
9. Sistema atualiza estado e notifica o usuário.

## Estados sugeridos
DRAFT, QUEUED, PROCESSING, AUTHORIZED, REJECTED, CANCEL_REQUESTED, CANCELLED, FAILED.

## Integração fiscal

O módulo `apps/api/src/fiscal` implementa um adaptador SEFIN exclusivo de produção restrita. Valida uma DPS assinada com os esquemas oficiais de 20/10/2026, vincula o certificado de assinatura ao A1 da conexão mTLS e interpreta os retornos após conferir ambiente e identificadores. O CLI é uma ferramenta administrativa independente da API HTTP e do PostgreSQL. A geração de DPS usa dados preenchidos pelo operador, confere o CNPJ do prestador com o e-CNPJ e valida a assinatura antes de salvar o XML localmente.

Antes do POST, o adaptador consulta o Id da DPS e reserva o identificador em um diário local. Se o resultado ficar incerto, volta a consultar a SEFIN e mantém a reserva. A etapa de fila poderá substituir esse diário por persistência por organização e coordenação distribuída. A integração ao painel exigirá sessão, papel autorizado e escopo pelo tenant da sessão.

O painel já prepara e assina uma DPS de produção restrita sem rede. A API deriva prestador, tomador, descrição e valor do rascunho e recebe os demais campos fiscais de forma explícita. O registro `PreparedDps` guarda o XML assinado, o identificador reservado, a versão do certificado e a versão do rascunho no escopo da empresa. A transação verifica se os dados mudaram durante a assinatura. A repetição do mesmo pedido retorna o identificador gravado, e o mesmo número não pode ser reaproveitado com dados diferentes. O painel retorna apenas metadados. As assinaturas locais mantêm o estado `DRAFT`.

`GET /api/customers/:id/invoices` lista os registros do cliente no tenant da sessão com paginação. `GET /api/customers/:id/invoices/dps/:dpsId.pdf` entrega um PDF de conferência da DPS local a partir do XML assinado armazenado. A rota exige que a DPS pertença ao cliente e corresponda à versão atual do rascunho. Os dados fiscais trafegam com `Cache-Control: no-store`. O DANFSe é consultado pelo portal com a chave de acesso quando o histórico contém uma NFS-e autorizada. [Consulta oficial de NFS-e e DANFSe](https://www.gov.br/pt-br/servicos/consultar-nota-fiscal-de-servico-eletronica)

O roteiro de homologação e as fontes versionadas estão em [HOMOLOGACAO_NFSE.md](HOMOLOGACAO_NFSE.md).
