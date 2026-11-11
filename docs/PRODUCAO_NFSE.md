# NFS-e em produção

A preparação está disponível para o proprietário da empresa configurada em `NFSE_PRODUCTION_PREPARATION_CNPJ`. Em **Fiscal → Rascunhos → Preparar DPS → Preparar emissão real**, selecione um rascunho com o tomador, a descrição e o valor da operação real. Informe os códigos e parâmetros fiscais da operação e a série e o número disponíveis do aplicativo próprio. A preparação cobre a DPS regular de serviço nacional emitida pelo prestador com A1. Consulte as regras em vigor para competência, retenção, endereço do tomador e grupos adicionais. [Documentação de produção](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual)

A DPS é assinada no servidor com `tpAmb=1`. O leiaute 1.01 é validado com o pacote oficial de 09/02/2026. O pacote de produção tem SHA-256 `e7935cbd9470527c6cc32984c1b2263e614183bf0139ce2733eaaed2de9a8072`. Os arquivos originais são preservados. O ajuste em memória do padrão de série está descrito no roteiro de homologação. Confirme a revisão vigente antes de liberar uma nota. [Pacote oficial](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/nfse-esquemas_xsd-v1-01-20260209.zip) · [Cronograma de implantação](https://www.gov.br/nfse/pt-br/noticias/nfs-e-nacional-confira-oas-rientacoes-sobre-leiaute-em-producao-regras-de-preenchimento-de-ibs-cbs-e-status-da-nota-tecnica-009)

## Autorização da primeira nota

1. O responsável confere os dados da DPS no painel e autoriza a versão específica.
2. Somente após essa autorização, configure o Id e o hash exibidos no painel em `NFSE_PRODUCTION_APPROVED_DPS_ID` e `NFSE_PRODUCTION_APPROVED_DPS_SHA256`. Ambos ficam ausentes na implantação inicial. Uma alteração nos dados ou no certificado exige nova preparação e revisão.
3. Na DPS autorizada, o proprietário revisa o tomador e o valor e confirma **Confirmar emissão real**. O sistema consulta a SEFIN pelo Id antes de enviar e grava a reserva no banco antes de qualquer POST de emissão.
4. Se ficar pendente, use **Consultar situação na SEFIN** ou consulte pela chave quando o Portal Nacional já mostrar a NFS-e. A consulta recupera o XML da mesma DPS. A reserva impede um novo envio. Uma rejeição confirmada libera o rascunho para revisão e requer outra DPS autorizada.
5. A NFS-e autorizada aparece em **Clientes → Ver notas**. O XML fica disponível no histórico e o DANFSe oficial é acessível pela consulta pública vinculada à chave. Remova o par de aprovação depois do piloto.

O fluxo de produção permanece separado da homologação. O transportador de produção verifica novamente o hash, o titular e o Id antes do POST. A consulta de produção com A1 em **Certificados** permanece somente leitura. As recorrências continuam criando rascunhos. [Manual oficial da API](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/manual-contribuintes-emissor-publico-api-sistema-nacional-nfs-e-v1-2-out2025.pdf)
