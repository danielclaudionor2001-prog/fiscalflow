# NFS-e em produção

Em **Plataforma → Empresas assinantes**, clique em **Liberar emissão** na linha de uma empresa ativa com CNPJ e A1 válido cadastrado. Confirme que a empresa está credenciada para emitir via API no Portal Nacional e finalize em **Confirmar liberação**. O painel verifica o A1 cadastrado e registra a confirmação do credenciamento feita pelo proprietário da plataforma. Use **Bloquear emissão** para impedir novas preparações e reservas de envio. As tentativas já reservadas continuam disponíveis para consultar. A renovação do A1 preserva a liberação da empresa, e cada DPS precisa ter sido assinada com o certificado em uso no envio. [Credenciamento para emissão via API](https://www.gov.br/pt-br/servicos/emitir-nota-fiscal-de-servico-eletronica)

O responsável pela empresa abre **Fiscal → Notas fiscais → Nova nota avulsa**, seleciona o tomador e informa a descrição, o valor e a competência da operação real. Em **Continuar para revisão**, preenche ou confere os códigos e parâmetros fiscais e a série e o número disponíveis do aplicativo próprio. A preparação cobre a DPS regular de serviço nacional emitida pelo prestador com A1. O painel aceita códigos nacionais, complementos municipais e NBS com a pontuação do Portal Nacional. [Documentação de produção](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual)

A DPS é assinada no servidor com `tpAmb=1`. O leiaute 1.01 é validado com o pacote oficial de 09/02/2026. O pacote de produção tem SHA-256 `e7935cbd9470527c6cc32984c1b2263e614183bf0139ce2733eaaed2de9a8072`. Os arquivos originais são preservados. O ajuste em memória do padrão de série está descrito no roteiro de homologação. Confirme a revisão vigente antes de liberar uma nota. [Pacote oficial](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/nfse-esquemas_xsd-v1-01-20260209.zip) · [Cronograma de implantação](https://www.gov.br/nfse/pt-br/noticias/nfs-e-nacional-confira-oas-rientacoes-sobre-leiaute-em-producao-regras-de-preenchimento-de-ibs-cbs-e-status-da-nota-tecnica-009)

Quando informado, o código NBS (`cNBS`) é gravado depois da descrição do serviço (`xDescServ`) no XML de produção, conforme a sequência do grupo `cServ` do esquema vigente.

## Reutilizar dados fiscais

Ao revisar uma nota para a emissão real, o painel guarda os parâmetros fiscais para aquele cliente e serviço. Se ainda não houver dados salvos, usa uma nota autorizada anteriormente para o mesmo cliente e serviço quando os dados forem compatíveis. Abra **Conferir ou editar os dados fiscais salvos** para revisar o preenchimento. A numeração sugerida usa as DPS preparadas no Fiscal Floow. Se a empresa usa outra aplicação na mesma série, confira o próximo número disponível.

Vincule um serviço do catálogo se a descrição variar entre notas. Sem serviço vinculado, o reaproveitamento considera o mesmo cliente e a mesma descrição. Em uma operação sem retenção e sem endereço do tomador na DPS, **Usar como padrão deste serviço para outros clientes sem retenção de ISSQN** permite configurar o mesmo serviço para novos clientes. O modelo guarda percentuais e parâmetros fiscais. Totais de tributos em reais são informados em cada operação.

## Envio e resultado

1. Clique em **Revisar nota**, confira a DPS preparada e clique em **Emitir NFS-e** na mesma tela. O sistema consulta a SEFIN pelo Id e grava a reserva no banco antes do POST de emissão.
2. Se ficar pendente, use **Consultar situação na SEFIN** ou consulte pela chave quando o Portal Nacional já mostrar a NFS-e. A consulta recupera o XML e verifica se corresponde à DPS assinada. A reserva impede um novo envio da mesma DPS. Uma rejeição confirmada libera **Revisar dados fiscais** na mesma tela.
3. A NFS-e autorizada aparece em **Fiscal → Notas fiscais → Notas emitidas** e em **Clientes → Ver notas**. O PDF é gerado a partir do XML autorizado. O Portal Nacional também disponibiliza o DANFSe.

## Configuração de implantação anterior

As empresas que ainda usam `NFSE_PRODUCTION_PREPARATION_CNPJ` sem uma decisão registrada no painel continuam com a aprovação por DPS. Nesse modo, o envio usa `NFSE_PRODUCTION_APPROVED_DPS_ID` e `NFSE_PRODUCTION_APPROVED_DPS_SHA256`. Uma liberação ou um bloqueio no painel passa a valer para a assinante e tem prioridade sobre essas variáveis.

O transportador de produção verifica o hash, o titular e o Id antes do POST. A consulta de produção com A1 em **Certificados** usa GET. As recorrências criam rascunhos. [Manual oficial da API](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/manual-contribuintes-emissor-publico-api-sistema-nacional-nfs-e-v1-2-out2025.pdf)
