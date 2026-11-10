# NFS-e Nacional em produção restrita

O Fiscal Floow oferece uma ferramenta administrativa para gerar, assinar e validar uma DPS, consultar seu Id, consultar a NFS-e por chave ou enviar uma DPS regular do próprio prestador. O destino do transporte é fixo em `https://sefin.producaorestrita.nfse.gov.br/SefinNacional`. O painel permite a preparação e a assinatura local. A transmissão fiscal pela API do painel está desabilitada. [Ambientes publicados pelo Portal Nacional](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/apis-prod-restrita-e-producao/apis-prod-restrita-e-producao)

## Versão e fontes

- O validador usa os esquemas de homologação `NFSe-ESQUEMAS_XSD-PRODREST-v1.01-20261020` da NT 009. O ZIP oficial tem SHA-256 `25fdcecc651a67a216496ab10d7566631e6ed10f721e37d62c7845dadb0ea267`. A pasta `apps/api/fiscal-schemas/sefin-20261020` contém os cinco arquivos usados, preservados byte a byte. [Portal de homologação e Anexo I](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita) · [ZIP oficial](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita/esquemas_prod_restrita_20261020.zip)
- As operações usadas são `GET /dps/{id}`, `GET /nfse/{chaveAcesso}` e `POST /nfse`. O envio usa o campo `dpsXmlGZipB64`. O XML de retorno vem em `nfseXmlGZipB64`. O link oficial de documentação respondeu HTTP 403 sem certificado. Os nomes JSON, códigos HTTP e o prefixo operacional `/SefinNacional` foram conferidos na exportação Swagger v1 de homologação, preservada em espelho público, com SHA-256 `87b717718e030eb3541cca710c62cf822ba78061cecbc9aa14253479ee18e689`. A confirmação do contrato publicado ao vivo depende de acesso autenticado. [Manual de Contribuintes](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/manual-contribuintes-emissor-publico-api-sistema-nacional-nfs-e.pdf) · [Exportação Swagger v1](https://github.com/nfse-nacional/nfse-php/blob/main/references/api-specs/homologation/API-NFS-e-Sefin-Nacional-%28v1%29.json)
- A identidade da pessoa jurídica é lida do `otherName` de CNPJ da ICP-Brasil. A checagem local verifica formato, validade, finalidade, par de chaves e titularidade. A SEFIN é responsável pelo aceite da cadeia, pela revogação e pelo credenciamento. [OID da ICP-Brasil](https://repositorio.iti.gov.br/instrucoes-normativas/IN2020_15_DOC-ICP-04.01.htm)

## Gerar e assinar sua DPS de teste

O gerador cobre uma DPS regular do próprio prestador para serviço nacional sujeito a ISSQN, com retenção pelo tomador ou sem retenção. Use um cenário de teste compatível com esse recorte. O modelo tem os campos do serviço, regime e total aproximado de tributos. Operações com grupos adicionais, como IBS/CBS, obra, benefícios ou retenções federais, requerem um XML preparado para o cenário correspondente. [Anexo I e esquemas de produção restrita](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita)

Na raiz do Fiscal Floow, crie o modelo em uma pasta do seu perfil e abra o JSON no Bloco de Notas.

```powershell
$pasta = Join-Path $env:LOCALAPPDATA 'FiscalFlow\Homologacao'
New-Item -ItemType Directory -Path $pasta -Force | Out-Null
$dados = Join-Path $pasta 'dps-dados.json'
$xml = Join-Path $pasta 'DPS-assinada.xml'
npm.cmd run nfse:homologacao -- modelo --saida "$dados"
notepad.exe "$dados"
```

Preencha o JSON e salve em UTF-8. Mantenha os números entre aspas para preservar zeros à esquerda. O programa exige os dados informados e os campos tributários aplicáveis ao seu caso.

| Campo | Preenchimento |
| --- | --- |
| `cnpjPrestador` | CNPJ do titular do A1, sem pontuação. Use letras maiúsculas se o CNPJ for alfanumérico |
| `cLocEmi` e `cLocPrestacao` | Códigos IBGE de sete dígitos para o município emissor e o município da prestação, respectivamente |
| `serie` e `nDPS` | Série de aplicativo próprio na faixa de 0 a 49999 e número sequencial disponível para teste |
| `dCompet` | Data de competência do cenário de teste no formato `AAAA-MM-DD` |
| `opSimpNac` e `regEspTrib` | Situação perante o Simples e código de regime especial. Para `opSimpNac`, use `1` para não optante, `2` para MEI ou `3` para ME/EPP optante. Se for `3`, acrescente `regApTribSN` conforme o Anexo I |
| `cTribNac`, `xDescServ` e `vServ` | Código nacional de tributação de seis dígitos, descrição do serviço de teste e valor com ponto decimal, por exemplo `"10.00"` |
| `tpRetISSQN` | `1` quando não houver retenção ou `2` para retenção pelo tomador |
| `totTrib` | Selecione uma forma de informar os totais conforme o Anexo I. O modelo usa `pTotTrib`, com percentuais federal, estadual e municipal. Alternativas são `vTotTrib` com os mesmos três campos em reais, `pTotTribSN` com o percentual aplicável a ME/EPP ou `indTotTrib` com valor `"0"` no cenário de MEI |

Acrescente `inscricaoMunicipal`, `cTribMun`, `cNBS` ou `pAliq` quando aplicáveis. Para identificar o tomador, inclua `"tomador": { "documento": "CPF ou CNPJ sem pontuação", "nome": "Nome ou razão social" }` com os dados autorizados para o teste. O tomador é obrigatório se `tpRetISSQN` for `2`. [Anexo I e códigos de serviço](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita)

Depois de salvar o JSON, informe o caminho do A1 e digite a senha no terminal quando solicitada.

```powershell
$pfx = (Read-Host 'Cole o caminho completo do e-CNPJ A1 (.pfx)').Trim().Trim('"')
```

Cole o caminho do arquivo quando o PowerShell pedir. Depois que o prompt voltar, rode o comando de geração.

```powershell
if (!$pfx -or !(Test-Path -LiteralPath $pfx -PathType Leaf)) {
  throw 'Informe o caminho de um arquivo de certificado A1 existente.'
}
npm.cmd run nfse:homologacao -- gerar --dados "$dados" --pfx "$pfx" --saida "$xml"
```

O comando cria o Id com os dados da DPS, fixa `tpAmb=2`, assina `infDPS` em memória e valida o XSD e a assinatura antes de salvar. O padrão XMLDSig do modelo conceitual usa RSA-SHA1, C14N e assinatura envelopada. O resultado `locally-signed` mostra o `idDps` para a consulta posterior e o caminho completo do XML em `arquivo`. O XML contém o certificado público. O PFX e a senha ficam no computador e a senha é digitada sem eco. Escolha um caminho de saída novo a cada geração. [Modelo conceitual e padrão XMLDSig](https://www.gov.br/nfse/pt-br/biblioteca/manuais-e-tutoriais/manual-integrado-nfse)

O arquivo é validado contra o pacote publicado em 20/10/2026. O CGNFS-e informou que a implantação das revisões da NT 009 em produção restrita é gradual. O aceite da versão e das regras fiscais depende do retorno da SEFIN no teste autenticado. [Comunicado do CGNFS-e](https://www.gov.br/nfse/pt-br/noticias/nfs-e-nacional-confira-oas-rientacoes-sobre-leiaute-em-producao-regras-de-preenchimento-de-ibs-cbs-e-status-da-nota-tecnica-009)

## Validar um XML antes de conectar

Use uma DPS assinada com a declaração inicial `<?xml version="1.0" encoding="UTF-8"?>`, leiaute `versao="1.01"`, `tpAmb=2` e `tpEmit=1`. O comando `gerar` inclui a declaração. A checagem local verifica a declaração, o XSD, o Id e a assinatura sobre `infDPS`. A validação das regras de negócio ocorre na SEFIN. [Padrão de documento XML, seção 6.1.1](https://www.gov.br/nfse/pt-br/biblioteca/eventos_NFS-e/evento-tecnico-setembro-de-2022/manualintegradosnnfse_v1-01-00-homologacao.pdf)

```powershell
npm.cmd run nfse:homologacao -- validar --arquivo "C:\caminho\teste-dps-assinada.xml"
```

O resultado `locally-validated` confirma apenas a validação local. Essa operação usa os XSDs do projeto e funciona sem conexão ou senha.

Se a geração ou o envio retornar `pfx-unlock-failed`, confira a senha do PFX no terminal. Esse código indica falha na verificação de integridade do arquivo com a senha digitada.

## Consultar e enviar em homologação

Guarde o A1 `.pfx` protegido por senha e os XMLs em um diretório de acesso restrito fora do projeto. O comando pede a senha sem eco. Em automação, passe a senha como uma linha na entrada padrão a partir do gerenciador de segredos. Use o mesmo certificado que assinou a DPS para transmitir. Para preparar a conexão, o CLI converte o envelope do PFX em memória e preserva o certificado e a cadeia. Isso permite carregar arquivos exportados com RC2-40. O transporte usa HTTPS com autenticação mútua, validação do servidor e TLS 1.2 ou superior.

```powershell
npm.cmd run nfse:homologacao -- consultar-dps --id "DPS..." --pfx "C:\caminho\certificado.pfx"
npm.cmd run nfse:homologacao -- consultar-nfse --chave "CHAVE..." --pfx "C:\caminho\certificado.pfx" --saida "C:\caminho\nfse-teste.xml"
npm.cmd run nfse:homologacao -- enviar --arquivo "C:\caminho\teste-dps-assinada.xml" --pfx "C:\caminho\certificado.pfx" --saida "C:\caminho\nfse-teste.xml"
```

Substitua `DPS...` pelo atributo `Id` completo e `CHAVE...` pela chave de 50 posições. O caminho `--saida` é opcional e deve estar livre. O terminal informa o estado e, quando disponível, a chave de acesso. Use a opção de arquivo para obter o XML.

| Estado | Significado |
| --- | --- |
| `authorized` | A SEFIN retornou HTTP 201 com XML de homologação correspondente à DPS |
| `reconciled` | A NFS-e foi localizada pelo Id da DPS e conferida pelo XML |
| `rejected` | A SEFIN rejeitou o envio e a consulta pelo Id ficou sem NFS-e. O resultado inclui os códigos e o horário de processamento informado pela SEFIN. O processo sai com código 2 |
| `indeterminate` | O resultado segue incerto. O processo sai com código 3 e preserva a reserva do Id |

Mantenha o diretório `.nfse-homologacao` entre execuções ou informe o mesmo caminho em `--estado`. O diário registra a reserva e o resultado por hash, com criação exclusiva para impedir dois POSTs pelo mesmo Id. Em caso de timeout ou retorno incerto, consulte a DPS pelo mesmo Id. Uma reserva anterior permite reconciliação, com reenvio automático desabilitado. O diário é local ao diretório escolhido e deve ser compartilhado entre as execuções que usam a mesma numeração.

Após uma rejeição confirmada, gere a DPS corrigida com o próximo número disponível para a série de teste e mantenha a tentativa anterior no diário. Para `E1229`, gere o XML novamente para incluir a declaração UTF-8 exigida pela SEFIN. [Atualizações do Portal Nacional](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/atualizacoes-e-implantacoes/atualizacoes-e-implantacoes)

O gerador grava a hora de geração da DPS em horário de Brasília, com o deslocamento explícito em `dhEmi`. Se a SEFIN devolver `E0008`, compare `dhEmi` com o campo `processadoEm` da rejeição. A hora de emissão precisa ser anterior ou igual à de processamento. [Regras da DPS em produção restrita](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita)

Se a consulta inicial retornar `invalid-response`, rode `consultar-dps` com o mesmo Id para repetir apenas a leitura. O campo `diagnostico` mostra o status HTTP, o formato e os campos esperados que a resposta apresentou. Ele inclui somente códigos fiscais reconhecíveis e omite o corpo da resposta e os valores dos identificadores.

O HTTP 404 com código `E2404` na consulta de DPS indica ausência de NFS-e para aquele Id. O adaptador reconhece também o formato abreviado com `tipoAmbiente=0`, data de processamento e erro `E2404`. Essa variante é aceita somente no HTTP 404 da consulta. O aceite de uma NFS-e exige o retorno de produção restrita e o XML correspondente.

## Critério de aceite

Os testes automatizados usam um certificado descartável e respostas locais sintéticas para verificar os bloqueios e o contrato. A homologação ponta a ponta deve registrar uma consulta autenticada e um envio de DPS de teste aceito, seguido da consulta da NFS-e devolvida. Use credenciais e dados habilitados para produção restrita.
