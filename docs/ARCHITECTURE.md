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

A apresentação pública é renderizada pelo `AuthGate` para visitantes sem sessão na raiz e nas âncoras da apresentação. O fragmento `#entrar` abre o login existente; convites têm precedência e orçamentos públicos seguem fora do gate. A consulta de sessão continua em execução, levando usuários autenticados ao painel. Animações ficam isoladas no CSS da apresentação, respeitam movimento reduzido e mantêm conteúdo acessível sem `IntersectionObserver`.

A identidade usa senha derivada com scrypt e salt aleatório. A sessão usa um identificador aleatório de 256 bits e armazena no PostgreSQL apenas o hash SHA-256 do identificador. A aplicação entrega o identificador em um cookie `HttpOnly` e `SameSite=Strict`, com `Secure` e prefixo `__Host-` em produção. A sessão expira após 30 minutos de inatividade ou oito horas no total. Um novo login revoga a sessão apresentada, e logout revoga no banco.

A API exige a origem do painel nas chamadas que alteram estado. O login tem limite por IP, e as respostas de autenticação evitam cache e detalhes sobre falhas internas. Provisionamento, login e revogação explícita registram eventos por empresa junto com a mutação correspondente. O cadastro inicial usa um comando administrativo que cria vínculos sem alterar credenciais existentes.

O CPF usado para entrar em uma empresa pertence ao vínculo do proprietário com aquela empresa. Sua alteração exige a senha atual, tem limite de tentativas e gera auditoria. O login lista contas candidatas somente após validar a senha. Cada escolha é conferida novamente contra os vínculos ativos antes de gerar a sessão. A mudança de papel do proprietário limpa o CPF vinculado.

Proprietários e administradores consultam os membros do tenant. Proprietários podem alterar o papel ou revogar o vínculo de outro membro. A transação bloqueia a organização e reconfirma o papel do ator para preservar pelo menos um proprietário, inclusive em operações concorrentes. Mudanças encerram as sessões do membro apenas na empresa afetada e registram o evento de auditoria.

O comando administrativo pode designar um vínculo `OWNER` como proprietário da plataforma. O painel de assinantes acessa apenas os dados cadastrais, o estado do acesso e as cobranças de assinatura dos tenants gerenciados. A suspensão é distinta do arquivamento e encerra as sessões da organização. A ativação de convidados usa um código aleatório no fragmento da URL. O servidor recebe apenas o hash ao criar o convite e verifica o código apresentado no resgate. A transação consome o convite, cria o vínculo e registra a auditoria. O primeiro convite de proprietário da plataforma pode ser criado pela configuração de inicialização do servidor. Seu privilégio fica associado ao convite persistido e é transferido somente ao vínculo criado no resgate. A inicialização protege contra convites privilegiados duplicados e contra recriação de contas existentes.

## Cadastros

Consultas e mutações de clientes e serviços filtram pela organização da sessão e excluem registros arquivados. Um serviço pode estar inativo no catálogo e continuar disponível para consulta. A rota da organização atual usa o mesmo contexto. O cabeçalho `X-FiscalFlow-Context` funciona como uma asserção adicional no painel e protege abas com uma organização desatualizada. O servidor deriva o escopo exclusivamente da sessão.

### Acompanhamento de boletos

O conector Asaas usa origens fixas distintas para Sandbox e produção, selecionadas por rotas do servidor. `AsaasConnection` pertence à organização, finalidade e ambiente, guarda a chave com AES-256-GCM e mantém somente o hash do token do webhook. HKDF e os dados autenticados distinguem os ambientes e preservam a criptografia anterior do Sandbox. A API retorna apenas metadados, sem credenciais. A conexão produtiva exige titularidade correspondente e aprovação cadastral. A preparação da cobrança não cria recursos no Asaas: a geração exige confirmação explícita e um hash atual de revisão que vincula boleto, nota autorizada, pagador, valor, vencimento e versão da conexão. Uma chave estrangeira composta e triggers impedem cruzar ambientes. O webhook consulta o recurso na mesma conta e só marca o boleto de produção como compensado quando a API retorna `RECEIVED`.

`AsaasCharge` referencia o boleto pela chave composta do tenant e a conta recebedora pela chave composta da organização da conexão. Essa separação permite que uma assinatura pertença à empresa pagadora e utilize a conta da plataforma. A reserva persistida e o bloqueio com prazo por conexão precedem chamadas de criação; qualquer tentativa já reservada é consultada, nunca reenviada. Valor, vencimento, referência e documento do pagador são reconfirmados no retorno. O acompanhamento do Sandbox fica separado do estado dos boletos reais.

`AsaasWebhookEvent` recebe apenas metadados necessários de eventos autenticados, com unicidade por conexão e ID do evento. O endpoint é montado antes da proteção de Origin do navegador e exige seu próprio token. O processador na API reivindica eventos com atualização condicional e consulta o recurso na API do Asaas para verificar o estado atual. Falhas permanecem em uma fila durável no PostgreSQL com retentativas limitadas. A auditoria registra a mutação sem conteúdo de credenciais ou payload bancário. Consulte [ASAAS.md](ASAAS.md) para escopo e validação exigida antes do uso operacional.

A redefinição do token exige proprietário, versão atual e a mesma trava por conexão usada nas operações bancárias. A chave existente é cifrada novamente dentro do cofre com a nova versão, sem ser devolvida ao painel e sem chamadas ao Asaas. A transação atualiza somente credencial cifrada, versão e hash do token com auditoria; a URL, a data de conexão e o histórico permanecem. O token anterior é invalidado e as revisões anteriores de boletos precisam ser refeitas. A troca não modifica conexões de outro ambiente ou finalidade.

`ReceivingAccount` registra os identificadores bancários por organização e finalidade. As duas finalidades separam o recebimento de serviços do recebimento de assinaturas. O cadastro manual de conta não recebe credenciais bancárias e o número completo da conta não é devolvido pela API; a chave do Asaas é recebida pelo formulário separado do cofre. Um `Boleto` de serviço usa uma chave estrangeira composta para a nota e copia dela o valor. Um boleto de assinatura tem a empresa assinante como escopo e usa o cadastro de recebimento da plataforma. O banco exige unicidade por nota ou por empresa e competência. A identificação da conta no histórico é preservada quando o cadastro muda.

O acompanhamento registra títulos externos. A baixa manual depende de um título registrado, e as transições usam atualização condicional para tratar solicitações concorrentes. Os filtros calculam o atraso na data civil de São Paulo. A API registra o ator na auditoria e separa o acesso da plataforma dos dados de cobrança dos clientes de cada empresa. O registro de um boleto não altera a situação da nota fiscal.

Um orçamento aprovado também pode gerar um conjunto de boletos planejados. O banco vincula cada parcela ao orçamento por chave composta da organização e preserva o acompanhamento legado de uma cobrança por nota ou competência de assinatura. A criação das parcelas é atômica e usa o bloqueio comercial. O identificador do orçamento e a posição da parcela garantem unicidade. Uma repetição com as mesmas condições devolve os registros existentes. A consulta pela nota inclui os boletos da proposta vinculada.

O conector Celcoin BaaS usa exclusivamente a origem HTTPS do Sandbox. O servidor seleciona a conexão pelo CNPJ da sessão e pela finalidade da cobrança, com segredos mantidos fora do banco e do frontend. Cada `CelcoinSandboxCharge` referencia o boleto com chave composta do tenant. A API grava um identificador externo único antes de solicitar a emissão, e uma reserva existente é reconciliada por consulta. O resultado só é aplicado se corresponder ao identificador, ao beneficiário, ao vencimento e ao valor do teste. A versão da linha coordena consultas concorrentes. O teste tem um pagador fictício e ciclo de status independente da cobrança acompanhada e do registro fiscal.

Criar uma empresa gera seu vínculo inicial de proprietário na mesma transação. Mutações cadastrais gravam um evento de auditoria com organização, ator, ação e ID do cadastro. O arquivamento da empresa revoga suas sessões na mesma transação. Bloqueios de linha coordenam novas sessões e alterações de catálogo com o arquivamento concorrente.

O painel cria, lista, edita e exclui registros `Invoice` no estado `DRAFT`. Novos vínculos exigem cliente disponível na empresa e serviço ativo, quando informado. A descrição e o valor são gravados no rascunho, e cada mutação fica registrada na auditoria junto com a transação. A restrição única de organização e chave de idempotência coordena criações repetidas e concorrentes. A exclusão grava `discardedAt` para preservar a chave e o histórico. Edição e exclusão conferem `updatedAt` antes da mutação.

A consulta de CPF ou CNPJ da nota avulsa usa a empresa da sessão e tem limite de requisições por empresa. Para um documento novo, valida os dígitos verificadores. A consulta de CPF ocorre apenas no cadastro da empresa e o operador preenche o nome completo se ainda não houver cliente. Para um CNPJ novo, a API envia o documento à BrasilAPI e repassa somente a razão social. A criação do cliente, do rascunho e da trilha de auditoria é atômica. A chave de organização e documento evita duplicidade e preserva o cadastro encontrado, inclusive em solicitações simultâneas.

Relatórios usam o mesmo escopo de rascunhos ativos e a data de criação no horário de Brasília. Totais e registros paginados vêm do mesmo snapshot do PostgreSQL. O CSV limita o tamanho da exportação e neutraliza campos que poderiam ser interpretados como fórmulas.

O painel mensal de emissões agrega no PostgreSQL apenas registros autorizados da organização da sessão. O período e os dias do gráfico usam `authorizedAt` convertido para `America/Sao_Paulo`. Uma consulta obtém as contagens diárias e os totais a partir do mesmo conjunto de registros e mantém a precisão decimal dos valores.

A preparação mensal usa `InvoiceSchedule` com chaves estrangeiras compostas para o rascunho modelo, o cliente e o serviço. Um agendador na API seleciona até 30 recorrências vencidas a cada minuto. Cada transação bloqueia a organização e a recorrência para criar o rascunho, registrar a ação da automação e avançar a data de forma atômica. Instâncias concorrentes usam `FOR UPDATE SKIP LOCKED` para coordenar a execução. Cliente indisponível ou serviço inativo pausa a recorrência. Essa preparação gera registros `DRAFT`. A fila de emissão fiscal é uma etapa separada.

Uma nota mensal também pode ser configurada sem rascunho modelo. Nesse caso, a chave parcial por organização, cliente e tipo garante uma única configuração de cada tipo e o dia fica fixo em 1. O agendador copia a categoria para o rascunho. Migrações classificam rascunhos anteriores como avulsos e configurações recorrentes anteriores como mensalidades.

O modo opcional `automaticProduction` exige autorização explícita de um `OWNER`, liberação produtiva da empresa no banco, A1 válido e modelo fiscal reutilizável. O consentimento vincula os dados da empresa, cliente, serviço, valor, descrição e parâmetros fiscais por hash. A ativação agenda somente o próximo dia 1 às 8h de Brasília. Alterações na configuração retiram o consentimento; mudanças cadastrais ou perda de permissão bloqueiam a execução antes da reserva de transmissão. Totais tributários absolutos que dependam de cada nota não são reutilizados automaticamente.

`AutomaticInvoiceRun` é uma fila durável no PostgreSQL, escopada por organização com chaves estrangeiras compostas. A unicidade por recorrência e mês impede duplicatas; reservas de numeração são serializadas com a preparação manual. O worker usa as mesmas funções de assinatura e transmissão do fluxo manual, com reconferência transacional imediatamente antes da gravação e do envio. Uma concessão temporária coordena instâncias concorrentes. Respostas incertas permanecem em `PENDING` e só permitem consulta, inclusive após reinício ou pausa. Rejeições e bloqueios pausam a recorrência. A recuperação não emite meses anteriores; exige revisão se o mês programado foi perdido. Não há rota de execução imediata nem criação de cobrança neste fluxo.

### Gestão comercial e caixa

Os perfis cadastrais adicionam campos opcionais nas tabelas existentes para endereço, regime tributário e representantes da organização, contatos financeiros de clientes e fornecedores e classificação de serviços e produtos. As rotas reaproveitam as autorizações, o escopo da sessão e a auditoria transacional. O cadastro do produto mantém a referência composta para o fornecedor. A migração é aditiva e executada em uma transação.

A validação de parâmetros fiscais normaliza códigos com pontuação, exige comprimentos compatíveis com os campos oficiais e reconfere o par CST/cClassTrib contra o registro persistido nas edições. Restrições do PostgreSQL também preservam o prefixo da classificação e os limites das alíquotas.

O NBS do catálogo é sugerido na DPS, participa da identificação de modelos fiscais quando preenchido e é enviado pelo campo já existente `cNBS`. O regime tributário da organização fornece uma sugestão ao formulário. Campos revisados da operação têm precedência. A projeção de `productionSourceHash` preserva a representação anterior para as DPS já preparadas. Os campos adicionais de classificação do IBS/CBS permanecem no perfil cadastral até a integração e a homologação do grupo fiscal correspondente.

A identidade comercial pertence à organização e tem campos de contato, logo e imagem opcional para a marca d’água. As imagens PNG têm dimensões e tamanho limitados. O painel, o Orçamento Express e o PDF usam a imagem própria no fundo ou o logo quando a marca d’água está ativa e a imagem própria está ausente.

O Orçamento Express vincula cada link à proposta pela chave composta da organização. O servidor armazena o hash do código aleatório e confere o documento do cliente antes de devolver os campos comerciais. O acesso tem limite de tentativas por IP e por link. A edição desativa o link. A resposta final grava uma ação de auditoria sem usuário interno e usa o mesmo bloqueio das mutações comerciais para preservar a versão aprovada ou recusada. O orçamento aprovado pode ser convertido pelo painel.

Fornecedores, produtos, movimentos de estoque, pedidos e contas operam no escopo da organização autenticada. Chaves estrangeiras compostas impedem referências cruzadas entre tenants. Os itens guardam nome, quantidade, preço e custo de produto na venda. A conversão preserva o orçamento ou a ordem original e cria uma única venda em aberto. Alterações em pedidos conferem a versão vista no painel.

A confirmação da venda registra o movimento de cada produto, o parcelamento e a comissão em uma transação. O bloqueio por organização coordena as mutações comerciais e o banco impede estoque e saldo negativos. A divisão de parcelas conserva o valor em centavos e ajusta o vencimento para o último dia nos meses curtos. Estornos e cancelamentos preservam a trilha de auditoria. Criação de pedidos, movimentos manuais e baixas usam chaves de idempotência por organização.

Uma venda confirmada com cliente e itens de um único serviço ativo pode gerar um rascunho fiscal vinculado. Produtos ficam fora do valor do rascunho. A ação reutiliza a validação cadastral da NFS-e. O painel de caixa agrega baixas não estornadas por data civil e mantém vendas confirmadas em uma métrica separada.

Um orçamento aprovado no Orçamento Express pode preparar a mesma NFS-e antes da conversão comercial. A ação procura uma nota ativa tanto na proposta quanto na venda vinculada, sob o bloqueio comercial, para preservar um único vínculo fiscal. A autorização fiscal segue a revisão da DPS e a confirmação de envio no fluxo normal.

## Cofre de certificados

O proprietário gerencia um certificado por organização. A importação exige a versão vista no painel para impedir substituições ou remoções concorrentes e grava a auditoria na transação. A API retorna somente situação, versão e datas. A validação do PKCS#12 e a assinatura usam um worker com tempo, memória e concorrência limitados. A chave privada e a senha não são incluídas em respostas nem em auditoria.

O arquivo e a senha são criptografados em conjunto com AES-256-GCM, nonce aleatório e autenticação vinculada à organização e à versão. A chave vem do gerenciador de segredos e não é gravada no PostgreSQL. A confiança é ancorada em raízes configuradas no servidor, e a importação compara o CNPJ do titular ao da sessão. A validação local não consulta listas de revogação. A remoção, a substituição e o arquivamento da empresa retiram a credencial anterior da tabela operacional. O ciclo de vida de cópias e backups segue as regras de retenção da instalação.

A consulta de produção fica disponível para o proprietário do CNPJ configurado. O worker usa o A1 da sessão somente para consultar uma chave do mesmo prestador no host oficial, com TLS autenticado e método GET fixo. O worker verifica ambiente, chave e prestador no XML e devolve apenas metadados. A auditoria registra o uso pela versão do A1. Nenhuma nota é importada no histórico por essa consulta.

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
`InvoiceSchedule.previousMonthDescription` é opcional e começa desativado nas programações existentes. Quando ativado, a descrição deve conter uma única referência como `DO MÊS DE NOVEMBRO,`. O agendador resolve o mês anterior a partir do período da execução no calendário de Brasília e grava o texto na nota antes da preparação da DPS. O hash da autorização considera a regra e o texto cadastrado, sem depender do mês corrente; a guarda da execução compara a descrição resolvida para `AutomaticInvoiceRun.period`. A descrição de documentos anteriores é preservada, inclusive nas consultas e retentativas. Referências inválidas pausam a programação antes de criar qualquer nota.

As mensalidades diretas têm unicidade por organização, cliente, contrato e tipo. A migração adiciona `contractName` vazio aos registros anteriores e preserva seus valores, pausas e autorizações. O índice parcial continua excluindo recorrências de rascunhos. Nomes de contrato são normalizados na entrada; os filtros também pesquisam as unidades. A autorização automática inclui o contrato no hash quando preenchido, mantendo o hash anterior para contratos vazios. Alterar uma programação revoga sua autorização automática como no fluxo existente.

`GET /api/schedules` deriva o escopo da sessão e aceita busca pelo nome do cliente (`q`), situação (`status=all|active|paused|automatic`), tipo (`kind`) e ordem (`sort=name_asc|name_desc|updated_desc`). A resposta mantém `items` e `hasNext`, acrescenta `matching` para o filtro e `summary` com totais de toda a empresa. São consultas sem mutações fiscais. Ordenação e filtros antecedem a paginação; o resumo não se limita à página visível.

O catálogo de clientes aceita ordenação pelo nome ou pela data de cadastro com desempate estável. Os seletores compartilham as opções com a página Clientes. Alterar busca ou ordem reinicia a paginação e cancela a consulta anterior, preservando o cliente já selecionado.

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

Antes do POST, o adaptador consulta o Id da DPS e reserva o identificador. O CLI usa o diário local. O painel usa uma transação no PostgreSQL, confere o papel de proprietário e valida o rascunho e a versão do certificado no momento da reserva. O A1 descriptografado é usado em um worker para o mTLS com a SEFIN de testes. Depois de reservar, o painel permite recuperar o resultado pela consulta, inclusive após reinicialização. A chave, o XML e a situação de homologação são vinculados à DPS no tenant da sessão e ficam separados das emissões com valor fiscal.

O painel já prepara e assina uma DPS de produção restrita sem rede. A API deriva prestador, tomador, descrição e valor do rascunho e recebe os demais campos fiscais de forma explícita. O registro `PreparedDps` guarda o XML assinado, o identificador reservado, a versão do certificado e a versão do rascunho no escopo da empresa. A transação verifica se os dados mudaram durante a assinatura. A repetição do mesmo pedido retorna o identificador gravado, e o mesmo número não pode ser reaproveitado com dados diferentes. O painel retorna apenas metadados. As assinaturas locais mantêm o estado `DRAFT`.

`GET /api/customers/:id/invoices` lista os registros do cliente no tenant da sessão com paginação. `GET /api/customers/:id/invoices/dps/:dpsId.pdf` entrega um PDF de conferência da DPS de teste para a versão atual do rascunho. `GET /api/customers/:id/invoices/:invoiceId/nfse.pdf` gera o DANFSe do XML autorizado no tenant da sessão, com QR Code de consulta oficial. O logo usado no cabeçalho é o disponibilizado na biblioteca do Portal Nacional. Os dados fiscais trafegam com `Cache-Control: no-store`. [Especificações do DANFSe](https://www.gov.br/nfse/pt-br/noticias/se-cgnfs-e-prorroga-o-prazo-para-adequacao-ao-novo-leiaute-do-danfse) · [Logos da NFS-e](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/logos-da-nfs-e)

O roteiro de homologação e as fontes versionadas estão em [HOMOLOGACAO_NFSE.md](HOMOLOGACAO_NFSE.md).

`GET /api/invoices/issued` lista as notas emitidas da organização da sessão por data de autorização. Devolve os dados da lista e a disponibilidade do XML. O botão da página **Notas fiscais** usa a mesma rota autenticada de PDF do histórico por cliente.

Os registros de `PreparedDps` usam organização, ambiente e Id como chave composta. O proprietário da plataforma registra a liberação no cadastro de cada assinante com A1 válido e confirmação do credenciamento. A decisão grava um evento de auditoria. A preparação real usa o XSD de produção e o A1 da empresa. Com a empresa liberada, cada confirmação do responsável vincula o transporte ao Id e ao hash do XML assinado. Na reserva, a API reconfere a liberação sob o bloqueio da organização, verifica o A1 e a versão do rascunho e move a nota para `PROCESSING`. A confirmação guarda chave e XML e muda a nota para `AUTHORIZED` na mesma transação. Uma resposta incerta só permite consulta, inclusive após o bloqueio de novas emissões. [Roteiro de produção](PRODUCAO_NFSE.md)
