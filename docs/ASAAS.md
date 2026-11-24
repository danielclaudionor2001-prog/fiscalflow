# Conexão Asaas no Fiscal Floow

Esta etapa integra **exclusivamente o Asaas Sandbox**. Não aceita chaves de produção nem acessa a API produtiva. A conta normal em `asaas.com` será usada em uma etapa posterior; ela não compartilha o cadastro ou a chave com `sandbox.asaas.com`.

## Preparar a conta de testes

1. Crie a conta em <https://sandbox.asaas.com/> com o CPF ou CNPJ da empresa que vai conectar. A conta de produção é independente.
2. Acesse a área de integrações do Asaas e gere uma chave da API específica do Sandbox. Confira as permissões necessárias para dados comerciais da conta, clientes e cobranças.
3. No Fiscal Floow, entre como responsável `OWNER` pela empresa e abra **Conta de recebimento**. Sem conta cadastrada, Asaas já vem selecionado. Se tiver uma conta manual, use **Conectar Asaas Sandbox** ou **Alterar conta → Asaas**. O seletor oferece Asaas e Meu banco; registros anteriores da Celcoin permanecem preservados. Agência e conta cadastradas manualmente não substituem a conexão por API.
4. Digite a chave apenas no campo protegido. Gere e copie um token do webhook; guarde-o em local seguro antes de salvar. Esse token é diferente da chave da API.
5. Clique em **Validar e conectar Asaas**. A API consulta os dados comerciais e compara o titular ao CPF ou CNPJ da organização da sessão. Só então seleciona Asaas (Sandbox) para as novas cobranças.
6. No painel Asaas Sandbox, configure o webhook com a URL exibida no Fiscal Floow e com o mesmo token que você guardou. Habilite os eventos de cobranças necessários, como `PAYMENT_CREATED`, `PAYMENT_UPDATED`, `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `PAYMENT_DELETED` e `PAYMENT_REFUNDED`.
7. Faça o teste completo com pagadores fictícios, sem usar contatos de terceiros. As notificações são desabilitadas nos clientes de teste criados pela integração.

Para cobranças de assinatura da própria plataforma, use **Conta das assinaturas → Asaas**, com a conta do titular da plataforma. Essa conexão tem finalidade própria e não substitui a conta usada pelas empresas para cobrar os seus clientes.

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

- O tenant e a finalidade vêm da sessão e da rota autorizada. O cliente não escolhe uma organização arbitrária no corpo da requisição.
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

Os testes automatizados usam um transporte local de contrato, com respostas controladas, para validar segurança e persistência. Isso não substitui a validação com uma chave e uma conta reais do Sandbox antes da habilitação operacional.
