import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, jsonMutation, RegistrationError } from "../registrations/api";
import type { Request } from "../commercial/shared";

type Connection = { version: string; connectedAt: string; webhookPath: string };
type State = { enabled: boolean; environment: "SANDBOX"; connection: Connection | null };

export function asaasError(error: unknown) {
  if (error instanceof RegistrationError) {
    const messages: Record<string, string> = {
      "asaas-key-invalid": "Use uma chave da API do Asaas Sandbox, sem espaços. Chaves de produção não são aceitas nesta etapa.",
      "asaas-auth": "O Asaas não validou essa chave de testes. Confira o ambiente e as permissões da API.",
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

export const asaasStatusLabel = (status: string) => ({
  AWAITING_LOOKUP: "Aguardando confirmação", PENDING: "Em aberto", CONFIRMED: "Pagamento confirmado no teste",
  RECEIVED: "Recebido no teste", RECEIVED_IN_CASH: "Recebimento informado no teste", OVERDUE: "Vencido no teste",
  DELETED: "Removido no Asaas", REFUNDED: "Estornado no teste", REFUND_REQUESTED: "Estorno solicitado",
  REFUND_IN_PROGRESS: "Estorno em processamento",
} as Record<string, string>)[status] ?? "Situação em conferência";

export function AsaasConnectionCard({ request, path, connected }: { request: Request; path: string; connected: () => void }) {
  const [state, setState] = useState<State>();
  const [editing, setEditing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [webhookToken, setWebhookToken] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    request<State>(path + "/asaas", { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) { setState(value); setEditing(!value.connection); }
    }).catch((error) => { if (!controller.signal.aborted) setError(asaasError(error)); });
    return () => controller.abort();
  }, [request, path, revision]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!state || busy) return;
    const form = event.currentTarget, fields = new FormData(form);
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await request<{ connection: Connection }>(path + "/asaas", jsonMutation("PUT", {
        apiKey: String(fields.get("apiKey") ?? ""), webhookToken, version: state.connection?.version ?? null,
      }));
      form.reset(); setWebhookToken(""); setState({ ...state, connection: result.connection }); setEditing(false);
      setNotice("Conexão de testes validada. O Asaas foi selecionado como conta de recebimento."); connected();
    } catch (error) { setError(asaasError(error)); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    if (!state?.connection || busy) return;
    setBusy(true); setError("");
    try {
      await request(path + "/asaas", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: state.connection.version }) });
      setState({ ...state, connection: null }); setEditing(true); setDisconnecting(false);
      setNotice("Credenciais removidas do cofre. O histórico de testes foi preservado.");
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
    <div className="registry-heading"><div><span className="asaas-badge">ASAAS SANDBOX</span><h2>Conecte sua conta Asaas</h2></div>
      <a href="https://sandbox.asaas.com/" target="_blank" rel="noopener noreferrer">Abrir Asaas de testes</a></div>
    <p>Gere boletos de demonstração e acompanhe os retornos sem movimentar dinheiro real. Cada empresa conecta a própria conta.</p>
    {error && <p className="registry-error" role="alert">{error}</p>}
    {notice && <p className="registry-notice" role="status">{notice}</p>}
    {!state && !error && <p role="status">Consultando conexão…</p>}
    {!state && error && <button className="button-secondary" onClick={() => { setError(""); setRevision((n) => n + 1); }}>Tentar novamente</button>}
    {state && !state.enabled && <p className="registry-error">O cofre desta instalação ainda precisa ser habilitado pelo suporte.</p>}
    {connection && <div className="asaas-connected"><strong>Conexão de testes validada</strong>
      <p>Atualizada em {new Date(connection.connectedAt).toLocaleString("pt-BR")}. A chave não é exibida nem pode ser recuperada pelo painel.</p>
      <label>URL para o webhook do Asaas<input readOnly value={webhookUrl} onFocus={(e) => e.currentTarget.select()} /></label>
      <div className="record-actions"><button className="button-secondary" onClick={() => void copy(webhookUrl, "URL do webhook copiada.")}>Copiar URL do webhook</button></div>
      <p>No Asaas Sandbox, configure essa URL, o token que você guardou e os eventos de cobranças. O Fiscal Floow confere o retorno com a API antes de atualizar o teste.</p>
      {!editing && <div className="record-actions">
        <button className="button-secondary" onClick={() => { setEditing(true); setNotice(""); }}>Substituir credenciais</button>
        <button className="button-secondary" onClick={() => setDisconnecting(true)}>Desconectar Asaas</button>
      </div>}
    </div>}
    {disconnecting && <div className="asaas-connected"><p>Remover as credenciais desta conexão? Isso interrompe as consultas automáticas dos testes, mas preserva o histórico.</p>
      <div className="record-actions"><button disabled={busy} onClick={() => void disconnect()}>Confirmar desconexão</button>
        <button className="button-secondary" disabled={busy} onClick={() => setDisconnecting(false)}>Voltar</button></div></div>}
    {state?.enabled && editing && <form className="record-form" onSubmit={save}>
      <fieldset disabled={busy}>
        <label className="receiving-wide">Chave da API do Asaas Sandbox<input name="apiKey" type="password" autoComplete="off" required minLength={32} maxLength={1024} /></label>
        <label className="receiving-wide">Token de autenticação do webhook<input name="webhookToken" type="password" autoComplete="off" required minLength={32} maxLength={255} value={webhookToken} onChange={(e) => setWebhookToken(e.currentTarget.value)} /></label>
        <div className="receiving-wide record-actions"><button type="button" className="button-secondary" onClick={() => {
          const bytes = crypto.getRandomValues(new Uint8Array(32)); setWebhookToken(Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join(""));
        }}>Gerar token do webhook</button>
          <button type="button" className="button-secondary" disabled={!webhookToken} onClick={() => void copy(webhookToken, "Token copiado. Guarde-o para informar no webhook do Asaas.")}>Copiar token</button></div>
      </fieldset>
      <p className="record-hint">Copie e guarde o token antes de salvar. Informe o mesmo token no Asaas. A API key deve ser de Sandbox e do CPF ou CNPJ desta empresa. Novos pagadores são criados com notificações desabilitadas.</p>
      <div className="record-actions"><button disabled={busy}>{busy ? "Validando…" : "Validar e conectar Asaas"}</button>
        {connection && <button type="button" className="button-secondary" disabled={busy} onClick={() => { setEditing(false); setWebhookToken(""); }}>Cancelar</button>}</div>
    </form>}
  </section>;
}
