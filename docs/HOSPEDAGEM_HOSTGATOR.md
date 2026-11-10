# Hospedar o Fiscal Floow na HostGator

## 1. Escolha a VPS

No Portal do Cliente, abra **VPS e Dedicados** e clique em **Criar VPS**. Escolha o plano e o ciclo de pagamento. No carrinho, na seção **Escolher sistema operacional**, selecione **SO simples → Ubuntu 22.04 LTS** ou **Aplicação → Docker**. Confira o valor da renovação antes de concluir. [Como contratar a VPS](https://suporte.hostgator.com.br/hc/pt-br/articles/45892434068243-Como-contratar-uma-VPS-na-HostGator)

A VPS precisa rodar Node.js e PostgreSQL. A tabela da HostGator lista ambos para VPS, junto com Docker. [Compatibilidade da HostGator](https://suporte.hostgator.com.br/hc/pt-br/articles/30811116692115-Quais-s%C3%A3o-as-compatibilidades-da-HostGator) · [Primeiros passos na VPS](https://suporte.hostgator.com.br/hc/pt-br/articles/30816739471123-Como-come%C3%A7ar-a-usar-a-VPS-na-HostGator)

Copie o IP público da VPS e confirme o acesso SSH. A chave privada do SSH fica com quem administra o servidor. [Acessar a VPS com Docker](https://suporte.hostgator.com.br/hc/pt-br/articles/49651476065171-Como-acessar-o-Docker-na-VPS-HostGator)

## 2. Aponte o endereço

Na zona DNS do domínio, crie um registro **A** com nome `app` e valor igual ao IP público da VPS. O endereço do painel será `https://app.seudominio.com.br`. Use o provedor que administra o DNS do domínio. [Como apontar um domínio na HostGator](https://suporte.hostgator.com.br/hc/pt-br/articles/43289544586899-Como-conectar-um-dom%C3%ADnio-%C3%A0-sua-VPS-HostGator)

## 3. Prepare o servidor e copie o código

Crie um usuário de serviço com acesso ao diretório `/srv/fiscalfloow`. Instale Node.js 24 LTS, npm, Git, Docker com Compose e Caddy. Confira com `node --version`, `docker compose version` e `caddy version`. Para uma VPS simples, siga as instalações oficiais. [Node.js](https://nodejs.org/pt-br/download) · [Docker Engine para Ubuntu](https://docs.docker.com/engine/install/ubuntu/) · [Instalação do Caddy](https://caddyserver.com/docs/install)

Copie a versão revisada do projeto para `/srv/fiscalfloow` a partir do repositório privado. Se usar SSH para clonar no servidor, use uma chave de implantação com acesso de leitura apenas a esse repositório. Arquivos do banco local, certificados A1 e arquivos com senhas ficam fora do código.

## 4. Configure o ambiente e o banco

Em `/srv/fiscalfloow`, crie `apps/api/.env` a partir de `apps/api/.env.example` e restrinja a leitura ao usuário do serviço. Use uma senha de banco exclusiva, como uma sequência aleatória hexadecimal de 32 bytes. Ajuste o domínio e os valores de exemplo abaixo.

```dotenv
NODE_ENV=production
API_HOST=127.0.0.1
PORT=3333
SERVE_WEB=true
WEB_ORIGIN=https://app.seudominio.com.br
TRUSTED_PROXY_IPS=127.0.0.1
POSTGRES_PASSWORD=SUBSTITUA_PELA_SENHA_DO_BANCO
DATABASE_URL=postgresql://fiscalflow:SUBSTITUA_PELA_SENHA_DO_BANCO@127.0.0.1:5432/fiscalflow?schema=public&connect_timeout=5&pool_timeout=5
```

As duas configurações do PostgreSQL usam a mesma senha. Senhas com caracteres especiais precisam de codificação de URL no valor de `DATABASE_URL`. O Compose do projeto publica PostgreSQL e Redis só na interface local. Restrinja o firewall às portas 80 e 443 e ao SSH administrativo.

Na raiz do projeto, use o usuário de implantação para instalar as dependências e compilar. Rode o Compose com uma conta autorizada a administrar o Docker.

```sh
npm ci --include=dev
docker compose --env-file apps/api/.env up -d --wait
npm run db:generate
npm run db:deploy
npm run build
```

## 5. Mantenha o painel ativo e habilite HTTPS

Configure um serviço systemd que execute o Node como o usuário de serviço. Substitua `/usr/bin/node` pelo caminho absoluto da instalação, conferido com `command -v node`. Com o projeto em `/srv/fiscalfloow`, salve a unidade em `/etc/systemd/system/fiscalfloow.service`.

```ini
[Unit]
Description=Fiscal Floow
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=fiscalfloow
WorkingDirectory=/srv/fiscalfloow/apps/api
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now fiscalfloow
curl --fail http://127.0.0.1:3333/api/health/ready
```

Adicione o bloco abaixo ao Caddyfile do servidor com o domínio real. O Caddy obtém e renova o certificado quando o DNS e as portas públicas estão disponíveis. [HTTPS automático do Caddy](https://caddyserver.com/docs/automatic-https)

```caddyfile
app.seudominio.com.br {
  reverse_proxy 127.0.0.1:3333
}
```

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail https://app.seudominio.com.br/api/health/ready
```

A sonda deve retornar `{"status":"ready"}`. Abra o endereço em outro computador e confira o cadeado HTTPS e o formulário de login.

## 6. Crie o acesso de proprietário e teste um convite

Na raiz do projeto, com acesso administrativo e usando a configuração de banco dessa instalação, substitua as informações de exemplo pelos dados da sua conta. O primeiro comando pede a senha no terminal. O Fiscal Floow exige de 15 a 128 caracteres.

```sh
npm run auth:provision -- --cnpj 00000000000100 --company "Minha empresa" --email proprietario@example.test --name "Responsável" --role OWNER
npm run auth:provision -- --cnpj 00000000000100 --email proprietario@example.test --role OWNER --platform-owner
```

Entre no painel e abra **Plataforma → Empresas assinantes**. Cadastre uma empresa fictícia, copie o link e abra em uma janela anônima. Ative o convite e verifique que a conta convidada entra na própria empresa. Teste a suspensão e a reativação antes de convidar clientes.

## 7. Prepare a operação

Configure backups periódicos do PostgreSQL em armazenamento separado e teste a restauração em outra base. Se houver dados da prévia para migrar, decida quais registros levar, faça o backup da origem e valide a restauração antes de apontar o domínio de uso. O certificado A1 e sua chave de criptografia exigem configuração própria no servidor.

Confira **Painel → Planilhas** com arquivos fictícios do Excel e CSV. A transmissão de NFS-e real pelo painel depende da homologação fiscal.
