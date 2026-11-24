import { useEffect, useRef, useState, type FormEvent } from "react";
import { errorMessage, jsonMutation, RegistrationError } from "../registrations/api";
import type { Request } from "../commercial/shared";

type Connection = { version: string; connectedAt: string; webhookPath: string };
type State = { enabled: boolean; environment: "SANDBOX" | "PRODUCTION"; connection: Connection | null };

export function asaasError(error: unknown) {
  if (error instanceof RegistrationError) {
    const messages: Record<string, string> = {
      "asaas-key-invalid": "Confira a chave completa e o ambiente selecionado: Sandbox ou Produção. Não misture as credenciais.",
      "asaas-key-production": "Essa chave é da conta normal do Asaas. Entre em sandbox.asaas.com e crie uma chave na conta de testes.",
      "asaas-webhook-invalid": "Confira o token do webhook. Use Gerar token do webhook e copie o novo token antes de salvar. A chave da API deve ficar somente no primeiro campo.",
      "invalid-input": "Confira os campos do Asaas e o token do webhook, sem espaços ou quebras de linha.",
      "asaas-auth": "O Asaas não validou a chave. Confira o ambiente e as permissões da API.",
      "asaas-account-pending": "A conta Asaas ainda tem pendências cadastrais. Conclua a aprovação na sua conta Asaas antes de gerar boletos reais.",
      "asaas-authorized-invoice-required": "Para cobrar pelo Asaas em produção, abra uma nota fiscal já autorizada, sem vínculo com orçamento nesta etapa. Rascunhos e testes não geram boletos reais.",
      "asaas-review-changed": "Os dados da cobrança mudaram. Abra novamente a revisão antes de autorizar.",
      "asaas-holder-mismatch": "A conta Asaas deve pertencer ao mesmo CPF ou CNPJ da empresa que está conectando.",
      "asaas-vault-unavailable": "O cofre de credenciais está indisponível. Entre em contato com o suporte.",
      "asaas-unconfigured": "Conecte o Asaas na Conta de recebimento antes de gerar o boleto de teste.",
      "asaas-connection-changed": "A conexão foi alterada ou está em uso. Atualize a página e confira antes de salvar.",
      "asaas-busy": "Há uma operação Asaas em andamento. Aguarde e consulte novamente.",
      "asaas-charge-unavailable": "Confira a conta Asaas selecionada, a situação e o vencimento da cobrança planejada.",
      "asaas-payer-required": "Confira o CPF ou CNPJ do cliente e o vínculo da cobrança com a nota ou o orçamento aprovado.",
      "asaas-managed-charge": "O teste Asaas tem acompanhamento próprio. Consulte a situação no Asaas sem registrar uma baixa real.",
      "asaas-response": "O retorno do Asaas precisa de conferência. Consulte o teste antes de tentar qualquer nova criação.",
      "asaas-unavailable": "Não foi possível confirmar a resposta do Asaas. Consulte a cobrança; não gere uma segunda para substituir o teste.",
    };
    if (error.code && messages[error.code]) return messages[error.code];
  }
  return errorMessage(error);
}

export const asaasStatusLabel = (status: string, environment: "SANDBOX" | "PRODUCTION" = "SANDBOX") => ({
  AWAITING_LOOKUP: "Aguardando confirmação", PENDING: "Em aberto", CONFIRMED: "Pagamento confirmado no teste",
  RECEIVED: "Recebido no teste", RECEIVED_IN_CASH: "Recebimento informado no teste", OVERDUE: "Vencido no teste",
  DELETED: "Removido no Asaas", REFUNDED: "Estornado no teste", REFUND_REQUESTED: "Estorno solicitado",
  REFUND_IN_PROGRESS: "Estorno em processamento",
} as Record<string, string>)[status]?.replace(environment === "PRODUCTION" ? / no teste/g : /$^/, "") ?? "Situação em conferência";

export function AsaasConnectionCard({ request, path, connected, production = false }: { request: Request; path: string; connected: () => void; production?: boolean }) {
  const endpoint = path + (production ? "/asaas-production" : "/asaas");
  const environmentLabel = production ? "produção" : "testes";
  const [state, setState] = useState<State>();
  const [editing, setEditing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [webhookToken, setWebhookToken] = useState("");
  const [invalidField, setInvalidField] = useState<"apiKey" | "webhookToken" | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (busy || !invalidField) return;
    const input = formRef.current?.elements.namedItem(invalidField);
    if (input instanceof HTMLInputElement) input.focus();
  }, [busy, invalidField]);
  useEffect(() => {
    const controller = new AbortController();
    request<State>(endpoint, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) { setState(value); setEditing(!value.connection); }
    }).catch((error) => { if (!controller.signal.aborted) setError(asaasError(error)); });
    return () => controller.abort();
  }, [request, endpoint, revision]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!state || busy) return;
    const form = event.currentTarget, fields = new FormData(form);
    setBusy(true); setError(""); setNotice(""); setInvalidField(null);
    try {
      const result = await request<{ connection: Connection }>(endpoint, jsonMutation("PUT", {
        apiKey: String(fields.get("apiKey") ?? ""), webhookToken, version: state.connection?.version ?? null,
      }));
      form.reset(); setWebhookToken(""); setState({ ...state, connection: result.connection }); setEditing(false);
      setNotice("Conexão de " + environmentLabel + " validada. O Asaas foi selecionado como conta de recebimento. Nenhum boleto foi gerado."); connected();
    } catch (error) {
      setError(asaasError(error));
      if (error instanceof RegistrationError) {
        setInvalidField(error.code === "asaas-webhook-invalid" ? "webhookToken"
          : error.code === "asaas-key-invalid" || error.code === "asaas-key-production" ? "apiKey" : null);
      }
    }
    finally { setBusy(false); }
  }
  async function disconnect() {
    if (!state?.connection || busy) return;
    setBusy(true); setError("");
    try {
      await request(endpoint, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: state.connection.version }) });
      setState({ ...state, connection: null }); setEditing(true); setDisconnecting(false);
      setNotice("Credenciais removidas do cofre. O histórico foi preservado.");
    } catch (error) { setError(asaasError(error)); }
    finally { setBusy(false); }
  }
  function generateToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    setWebhookToken(Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join(""));
  }
  async function rotateToken() {
    if (!state?.connection || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await request<{ connection: Connection }>(endpoint + "/webhook-token", jsonMutation("POST", {
        version: state.connection.version, webhookToken,
      }));
      setState({ ...state, connection: result.connection }); setWebhookToken(""); setRotating(false);
      setNotice("Token do webhook atualizado. Informe o novo token no Asaas. A chave da API e o histórico foram preservados; nenhum boleto foi gerado.");
    } catch (error) { setError(asaasError(error)); }
    finally { setBusy(false); }
  }
  const connection = state?.connection;
  const webhookUrl = connection ? window.location.origin + connection.webhookPath : "";
  async function copy(text: string, message: string) {
    try { await navigator.clipboard.writeText(text); setNotice(message); }
    catch { setError("O navegador não permitiu copiar. Confira a permissão de área de transferência."); }
  }
  return <section className="registry-card asaas-connection">
    <div className="registry-heading"><div><span className="asaas-badge">{production ? "ASAAS PRODUÇÃO" : "ASAAS SANDBOX"}</span><h2>Conecte sua conta Asaas</h2></div>
      <a href={production ? "https://www.asaas.com/" : "https://sandbox.asaas.com/"} target="_blank" rel="noopener noreferrer">{production ? "Abrir minha conta Asaas" : "Abrir Asaas de testes"}</a></div>
    <p>{production ? "Conecte a conta real da sua empresa. Cada boleto exige revisão e autorização; conectar a chave não gera cobranças. O histórico Sandbox é preservado." : "Gere boletos de demonstração e acompanhe os retornos sem movimentar dinheiro real. Cada empresa conecta a própria conta."}</p>
    {error && <p className="registry-error" role="alert">{error}</p>}
    {notice && <p className="registry-notice" role="status">{notice}</p>}
    {!state && !error && <p role="status">Consultando conexão…</p>}
    {!state && error && <button className="button-secondary" onClick={() => { setError(""); setRevision((n) => n + 1); }}>Tentar novamente</button>}
    {state && !state.enabled && <p className="registry-error">O cofre desta instalação ainda precisa ser habilitado pelo suporte.</p>}
    {connection && <div className="asaas-connected"><strong>Conexão de {environmentLabel} validada</strong>
      <p>Atualizada em {new Date(connection.connectedAt).toLocaleString("pt-BR")}. A chave não é exibida nem pode ser recuperada pelo painel.</p>
      <label>URL para o webhook do Asaas<input readOnly value={webhookUrl} onFocus={(e) => e.currentTarget.select()} /></label>
      <div className="record-actions"><button className="button-secondary" onClick={() => void copy(webhookUrl, "URL do webhook copiada.")}>Copiar URL do webhook</button></div>
      <p>Na conta Asaas de {environmentLabel}, configure essa URL, o token que você guardou e os eventos de cobranças. O Fiscal Floow confere cada retorno com a API antes de atualizar a cobrança.</p>
      {!editing && !rotating && !disconnecting && <div className="record-actions">
        <button className="button-secondary" disabled={busy} onClick={() => { setEditing(true); setNotice(""); }}>Substituir credenciais</button>
        <button className="button-secondary" disabled={busy} onClick={() => { setRotating(true); setNotice(""); setError(""); generateToken(); }}>Redefinir token do webhook</button>
        <button className="button-secondary" disabled={busy} onClick={() => setDisconnecting(true)}>Desconectar Asaas</button>
      </div>}
    </div>}
    {connection && rotating && <div className="asaas-connected">
      <h3>Redefinir token do webhook</h3>
      <p>O token anterior deixará de funcionar ao salvar. Copie o novo token e informe o mesmo valor no webhook da sua conta Asaas de {environmentLabel}.</p>
      <label>Novo token do webhook<input type="password" autoComplete="off" minLength={32} maxLength={255} value={webhookToken} disabled={busy} onChange={(e) => setWebhookToken(e.currentTarget.value)} /></label>
      <div className="record-actions">
        <button type="button" className="button-secondary" disabled={busy} onClick={generateToken}>Gerar outro token</button>
        <button type="button" className="button-secondary" disabled={busy || !webhookToken} onClick={() => void copy(webhookToken, "Novo token copiado. Guarde-o para informar no Asaas antes de salvar.")}>Copiar novo token</button>
        <button type="button" disabled={busy || webhookToken.length < 32} onClick={() => void rotateToken()}>{busy ? "Salvando…" : "Salvar novo token"}</button>
        <button type="button" className="button-secondary" disabled={busy} onClick={() => { setRotating(false); setWebhookToken(""); }}>Cancelar</button>
      </div>
    </div>}
    {disconnecting && <div className="asaas-connected"><p>Remover as credenciais desta conexão? Isso interrompe as consultas automáticas, mas preserva o histórico. Boletos já gerados não serão cancelados no Asaas.</p>
      <div className="record-actions"><button disabled={busy} onClick={() => void disconnect()}>Confirmar desconexão</button>
        <button className="button-secondary" disabled={busy} onClick={() => setDisconnecting(false)}>Voltar</button></div></div>}
    {state?.enabled && editing && <form ref={formRef} className="record-form" onSubmit={save}>
      <fieldset disabled={busy}>
        <label className="receiving-wide">Chave da API do Asaas {production ? "Produção" : "Sandbox"}<input name="apiKey" type="password" autoComplete="off" aria-invalid={invalidField === "apiKey"} required minLength={32} maxLength={1024} /></label>
        <label className="receiving-wide">Token de autenticação do webhook<input name="webhookToken" type="password" autoComplete="off" aria-invalid={invalidField === "webhookToken"} required minLength={32} maxLength={255} value={webhookToken} onChange={(e) => setWebhookToken(e.currentTarget.value)} /></label>
        <div className="receiving-wide record-actions"><button type="button" className="button-secondary" onClick={generateToken}>Gerar token do webhook</button>
          <button type="button" className="button-secondary" disabled={!webhookToken} onClick={() => void copy(webhookToken, "Token copiado. Guarde-o para informar no webhook do Asaas.")}>Copiar token</button></div>
      </fieldset>
      <p className="record-hint">Copie e guarde o token antes de salvar. Informe o mesmo token no Asaas. A chave deve ser de {environmentLabel} e do CPF ou CNPJ desta empresa. Novos pagadores são criados com notificações desabilitadas.</p>
      {production && <label className="checkbox-field"><input type="checkbox" required />Entendo que esta é minha conta real e que os boletos só serão gerados após autorização na revisão.</label>}
      <div className="record-actions"><button disabled={busy}>{busy ? "Validando…" : "Validar e conectar Asaas"}</button>
        {connection && <button type="button" className="button-secondary" disabled={busy} onClick={() => { setEditing(false); setWebhookToken(""); }}>Cancelar</button>}</div>
    </form>}
  </section>;
}
