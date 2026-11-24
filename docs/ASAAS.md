# Conexão Asaas no Fiscal Floow

O Fiscal Floow mantém conexões independentes para **Asaas Sandbox** e **Asaas Produção**. A rota de testes continua rejeitando chaves de produção. A conexão real aceita apenas chaves de produção e acessa exclusivamente `https://api.asaas.com/v3`; o endereço da API nunca é recebido do navegador. As contas não compartilham cadastros ou credenciais.

## Conectar a conta normal e preparar a primeira cobrança

1. Na conta normal do Asaas, conclua a aprovação cadastral e gere a chave de API pela área de Integrações. Não envie a chave no chat ou em documentos.
2. Como proprietário da empresa correta no Fiscal Floow, abra **Conta de recebimento → Alterar conta → Asaas · Produção**.
3. Digite a chave no campo protegido. Gere e guarde um token próprio do webhook. Confirme que está conectando sua conta real e clique em **Validar e conectar Asaas**. O servidor consulta somente dados comerciais e situação cadastral; exige o mesmo CPF/CNPJ da empresa e `general = APPROVED`. Nenhum cliente ou boleto é criado nesta operação.
4. Configure o webhook na conta normal do Asaas com a URL e o token próprios da conexão de produção, API v3, webhook e fila ativos e os eventos de cobranças descritos abaixo. Não troque os tokens entre ambientes.
5. Abra **Notas fiscais → Ver cobrança** em uma nota real autorizada. Informe o vencimento e salve o planejamento. Isso é apenas um registro interno.
6. Clique em **Revisar boleto real** e confira cliente, CPF/CNPJ, valor, vencimento, descrição e chave da nota. Deixe a autorização desmarcada enquanto aguarda a aprovação.
7. Somente após a aprovação, marque **Conferi os dados e autorizo gerar este boleto real** e clique em **Autorizar e gerar boleto real**. O servidor reconfirma os dados revisados e a aprovação da conta. Novos pagadores são criados sem e-mail/telefone e com notificações desabilitadas; o responsável compartilha o boleto após conferir o PDF.
8. Acompanhe o status no Fiscal Floow. O webhook autentica o evento e consulta a mesma conta para conferir pagador, referência, valor e vencimento. `RECEIVED` marca o boleto de produção como compensado. `CONFIRMED` permanece distinto de saldo recebido. Sandbox nunca dá baixa real.

A produção desta etapa cobre cobrança direta de NFS-e autorizada com XML e chave salvos, sem vínculo com orçamento. Orçamentos e assinaturas permanecem no fluxo anterior. Não há débito, saque, transferência, emissão fiscal pelo Asaas, cancelamento bancário automático ou geração automática de boletos ao emitir uma nota.

Se houver timeout, use **Consultar boleto Asaas**. Uma reserva existente nunca repete a criação. Não faça outra cobrança para substituir uma tentativa inconclusiva. Desconectar a conta interrompe a conciliação e preserva o histórico; não cancela boletos no Asaas.

Os testes locais usam transporte controlado, sem credenciais ou cobranças reais. Cobrem ambientes, criptografia compatível com o legado, isolamento entre empresas, rejeição de rascunhos, revisão sem POST externo, autorização obrigatória, alterações após a revisão, timeout e webhook autenticado. A primeira cobrança real depende da conexão e da autorização do responsável; não declare emissão antes do retorno efetivo da API.

## Preparar a conta de testes

1. Crie a conta em <https://sandbox.asaas.com/> com o CPF ou CNPJ da empresa que vai conectar. A conta de produção é independente.
2. Acesse a área de integrações do Asaas e gere uma chave da API específica do Sandbox. Confira as permissões necessárias para dados comerciais da conta, clientes e cobranças.
3. No Fiscal Floow, entre como responsável `OWNER` pela empresa e abra **Conta de recebimento**. Sem conta cadastrada, Asaas já vem selecionado. Se tiver uma conta manual, use **Conectar Asaas Sandbox** ou **Alterar conta → Asaas**. O seletor oferece Asaas e Meu banco; registros anteriores da Celcoin permanecem preservados. Agência e conta cadastradas manualmente não substituem a conexão por API.
4. Digite a chave apenas no campo protegido. Gere e copie um token do webhook; guarde-o em local seguro antes de salvar. Esse token é diferente da chave da API.
5. Clique em **Validar e conectar Asaas**. A API consulta os dados comerciais e compara o titular ao CPF ou CNPJ da organização da sessão. Só então seleciona Asaas (Sandbox) para as novas cobranças.
6. No painel Asaas Sandbox, configure o webhook com a URL exibida no Fiscal Floow e com o mesmo token que você guardou. Habilite os eventos de cobranças necessários, como `PAYMENT_CREATED`, `PAYMENT_UPDATED`, `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `PAYMENT_DELETED` e `PAYMENT_REFUNDED`.
7. Faça o teste completo com pagadores fictícios, sem usar contatos de terceiros. As notificações são desabilitadas nos clientes de teste criados pela integração.

Para cobranças de assinatura da própria plataforma, use **Conta das assinaturas → Asaas**, com a conta do titular da plataforma. Essa conexão tem finalidade própria e não substitui a conta usada pelas empresas para cobrar os seus clientes.

Se houver erro ao conectar, o painel identifica se a chave é de produção, se o formato da chave está incompleto ou se o token do webhook precisa ser corrigido. Os valores rejeitados não são incluídos na resposta nem nos logs. O token do webhook deve ser diferente da chave da API. Campos inválidos são rejeitados antes de qualquer consulta ao Asaas.

## Gerar e acompanhar um boleto de teste

1. Abra a cobrança vinculada a uma nota ou a um orçamento aprovado. Planeje o boleto à vista ou as parcelas mensais e confira o total e os vencimentos.
2. Clique em **Gerar boleto Asaas de teste**, confira o pagador e o valor e confirme a geração. Cada parcela planejada é um título individual; não é criado um carnê Asaas nessa etapa.
3. Depois da resposta validada, use **Abrir PDF do boleto de teste** ou **Ver fatura de teste no Asaas**.
4. Use **Consultar teste Asaas** para recuperar uma resposta perdida ou conciliar pontualmente. Uma tentativa já reservada nunca repete o POST de criação.
5. Confirme o pagamento somente pelos recursos do Sandbox Asaas para testar o webhook. `CONFIRMED` e `RECEIVED` são apresentados separadamente. Nenhum desses estados de Sandbox dá baixa em recebimentos reais nem autoriza uma NFS-e.

Respostas inconclusivas permanecem em conferência. Não crie outra cobrança para substituir uma tentativa cujo resultado ainda seja desconhecido. O suporte deve verificar a referência no Asaas se a consulta continuar sem resultado.

## Cofre e configuração do servidor

As chaves de API são recebidas apenas por HTTPS em produção e armazenadas com AES-256-GCM, nonce aleatório e dados autenticados vinculados a organização, finalidade e versão. Nunca são devolvidas pela API, gravadas em auditoria ou incluídas em mensagens de erro. O token de webhook é guardado somente como SHA-256. A desconexão apaga o conteúdo cifrado e invalida o token preservando o histórico.

Injete `BILLING_CREDENTIAL_KEY` como segredo externo de 32 bytes em base64url. Quando esse valor não estiver configurado, o sistema pode derivar uma chave separada de `FISCAL_CERTIFICATE_KEY`, com HKDF e domínio específico para cobranças. Nenhuma chave Asaas deve ser colocada no repositório ou em exemplos de `.env`.

Antes da publicação, aplique `npm run db:deploy` e gere os clientes com `npm run db:generate`. A migração é aditiva: inclui o provedor ASAAS, conexões, tentativas e eventos pendentes, sem apagar dados existentes.

## Segurança e conciliação

- O tenant e a finalidade vêm da sessão e da rota autorizada; o ambiente vem de uma rota fixa do servidor. O cliente não escolhe uma organização ou host arbitrário.
- Ambiente persistido, chave estrangeira composta e triggers impedem vincular um boleto de produção a uma conexão Sandbox. O cofre separa a derivação de chave e os dados autenticados de cada ambiente, preservando o formato anterior do Sandbox.
- Cobranças de assinatura pertencem à empresa pagadora, mas usam exclusivamente a conexão da plataforma. Chaves estrangeiras compostas preservam os vínculos corretos.
- Uma reserva persistida precede qualquer POST externo. Uma trava com prazo por conexão coordena operações concorrentes. `externalReference` serve para correlação e consulta; não é tratado como garantia de idempotência do Asaas.
- O retorno é conferido por identificador, pagador, documento, referência, valor e vencimento. Links expostos precisam ser HTTPS do domínio Sandbox permitido.
- O webhook autentica `asaas-access-token`, persiste o identificador do evento sem duplicar e responde depois da gravação. Não considera o status ou valor do payload como prova de pagamento.
- O processamento posterior consulta a API com a credencial da conta, reconfirma os vínculos e usa atualização condicional. Eventos falhos ficam em fila durável no PostgreSQL com tentativas limitadas. Monitore eventos com dez tentativas e reavalie-os antes de uma futura entrada em produção.
- Não há pagamento de contas, transferências, débito em conta, emissão de Pix, cobrança por cartão ou emissão fiscal pelo Asaas nesta etapa.

## Rotas

| Rota | Uso |
| --- | --- |
| `GET, PUT, DELETE /api/receiving-account/asaas` | Situação, conexão ou desconexão da empresa |
| `GET, PUT, DELETE /api/receiving-account/asaas-production` | Conexão independente da conta normal, sem gerar cobranças |
| `GET /api/boletos/:id/asaas-production/review` | Dados e hash da revisão, sem chamada à API externa |
| `POST /api/boletos/:id/asaas-production` | Exige `confirmProduction: true` e `reviewHash` atual para criar o boleto real |
| `POST /api/boletos/:id/asaas-production/consultar` | Consulta a tentativa existente sem repetir a criação |
| `GET, PUT, DELETE /api/platform/receiving-account/asaas` | Conexão destinada às assinaturas da plataforma |
| `POST /api/boletos/:id/asaas-sandbox` | Reserva e cria um boleto de teste com `confirmTest: true` |
| `POST /api/boletos/:id/asaas-sandbox/consultar` | Consulta sem repetir a criação |
| `POST /api/platform/companies/:companyId/boletos/:id/asaas-sandbox` | Geração de teste para assinatura |
| `POST /api/platform/companies/:companyId/boletos/:id/asaas-sandbox/consultar` | Consulta de teste para assinatura |
| `POST /api/webhooks/asaas/:connectionId` | Recepção autenticada de eventos, sem cookie ou Origin de navegador |

## Referências oficiais consultadas

- [Sandbox](https://docs.asaas.com/docs/sandbox)
- [Recuperar dados comerciais](https://docs.asaas.com/reference/recuperar-dados-comerciais)
- [Criar e localizar clientes](https://docs.asaas.com/docs/criando-um-cliente)
- [Cobranças via boleto](https://docs.asaas.com/docs/cobrancas-via-boleto)
- [Listar cobranças e filtrar externalReference](https://docs.asaas.com/reference/listar-cobrancas)
- [Recepção de webhooks](https://docs.asaas.com/docs/receive-asaas-events-at-your-webhook-endpoint)
- [Eventos de cobranças](https://docs.asaas.com/docs/webhook-para-cobrancas)
- [Chaves e endereços por ambiente](https://docs.asaas.com/docs/chaves-de-api)
- [Situação cadastral da conta](https://docs.asaas.com/reference/consultar-situacao-cadastral-da-conta)

Os testes automatizados usam um transporte local de contrato, com respostas controladas, para validar segurança e persistência. Isso não substitui a validação com uma chave e uma conta reais do Sandbox antes da habilitação operacional.
