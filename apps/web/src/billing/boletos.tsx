import { DateInput } from "../formatted-inputs";
import { civilDateLabel } from "../format";
import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, jsonMutation, RegistrationError, useRegistrationRequest, type PageAccess } from "../registrations/api";
import { asaasError, asaasStatusLabel } from "./asaas-connection";

const labels = {
  PLANNED: "Planejado", REGISTERED: "Em aberto", OVERDUE: "Atrasado",
  SETTLED: "Compensado · baixa manual", CANCELLED: "Cancelado",
};
type Status = Exclude<keyof typeof labels, "OVERDUE">;
type Action = Exclude<Status, "PLANNED">;
const sandboxLabels = {
  AWAITING_LOOKUP: "Aguardando consulta", PROCESSING: "Em processamento", PENDING: "Em aberto",
  CONFIRMED: "Crédito confirmado no teste", CANCELED: "Cancelado", ERROR: "Falha na geração",
};
type SandboxCharge = {
  status: keyof typeof sandboxLabels; amount: string; dueDate: string; bankLine: string | null; overdue: boolean;
};
type Provider = "OWN_BANK" | "CELCOIN" | "ASAAS";
type AsaasCharge = { environment: "SANDBOX"; status: string; amount: string; dueDate: string; bankSlipUrl: string | null;
  invoiceUrl: string | null; errorCode: string | null; overdue: boolean };
type Boleto = {
  id: string; invoiceId: string | null; period: string | null; payerName: string;
  quoteId: string | null; installment: number | null; installments: number | null;
  amount: string; dueDate: string; status: Status; bankName: string; accountLastFour: string;
  issuerReference: string | null; overdue: boolean;
  provider: Provider; sandbox: SandboxCharge | null; asaas: AsaasCharge | null;
};
type Listing = {
  company: { legalName: string } | null;
  account: { bankName: string; accountLastFour: string; provider: Provider } | null;
  invoice: { id: string; amount: string; serviceDescription: string; status: string; customer: { name: string } } | null;
  quote: { id: string; customerName: string | null; amount: string; status: string } | null;
  items: Boleto[];
  hasNext: boolean;
  sandboxConfigured: boolean;
  asaasConfigured: boolean;
};
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const month = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", month: "long", year: "numeric" });

function billingError(error: unknown) {
  if (error instanceof RegistrationError && error.code?.startsWith("asaas-")) return asaasError(error);
  if (error instanceof RegistrationError) {
    if (error.code === "receiving-account-required") return "Cadastre a conta de recebimento antes de continuar.";
    if (error.code === "duplicate-registration") return "Já existe uma cobrança para esta nota ou competência.";
    if (error.code === "boleto-status-conflict") return "A situação do boleto mudou. Atualize a lista e confira o registro.";
    if (error.code === "amount-required") return "A cobrança precisa ter valor maior que zero.";
    if (error.code === "quote-unavailable") return "Este orçamento não está disponível para cobrança.";
    if (error.code === "quote-boletos-exist") return "Este orçamento já tem uma cobrança. Atualize a lista para consultar os boletos.";
    if (error.code === "quote-billing-required") return "Abra a cobrança pelo orçamento aprovado.";
    if (error.code === "installment-too-small") return "O valor do orçamento é insuficiente para essa quantidade de parcelas.";
    if (error.code === "boleto-due-in-past") return "Informe um primeiro vencimento a partir de hoje.";
    if (error.code === "celcoin-sandbox-unconfigured") return "A conexão Celcoin Sandbox está pendente para esta conta.";
    if (error.code === "celcoin-sandbox-unavailable") return "Selecione uma cobrança planejada para Celcoin e confira a conta de recebimento.";
    if (error.code === "celcoin-sandbox-auth") return "A Celcoin não confirmou a autenticação do Sandbox. Confira a configuração do servidor.";
    if (error.code === "celcoin-sandbox-response") return "A Celcoin ainda não retornou uma situação confirmada para este teste. Consulte novamente em instantes.";
  }
  return errorMessage(error);
}

export function BoletosPage({ organizationId, role, endSession, companyId, invoiceId, quoteId }: PageAccess & {
  companyId?: string | null; invoiceId?: string | null; quoteId?: string | null;
}) {
  const request = useRegistrationRequest(organizationId, endSession);
  const path = companyId ? "platform/companies/" + encodeURIComponent(companyId) + "/boletos" : "boletos";
  const accountLink = companyId ? "#conta-assinaturas" : "#recebimento";
  const canWrite = role === "OWNER" || role === "ADMIN";
  const [listing, setListing] = useState<Listing>();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  const [paymentMode, setPaymentMode] = useState<"single" | "installments">("single");
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<{ item: Boleto; action: Action }>();
  const [asaasSelection, setAsaasSelection] = useState<Boleto>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const abort = new AbortController();
    const query = new URLSearchParams({ page: String(page) });
    if (invoiceId) query.set("invoiceId", invoiceId);
    if (quoteId) query.set("quoteId", quoteId);
    if (filter) query.set("state", filter);
    setListing(undefined);
    request<Listing>(path + "?" + query.toString(), { signal: abort.signal })
      .then((data) => { if (!abort.signal.aborted) setListing(data); })
      .catch((failure) => { if (!abort.signal.aborted) setError(billingError(failure)); });
    return () => abort.abort();
  }, [path, invoiceId, quoteId, filter, page, revision, request]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (selection) {
        await request(path + "/" + encodeURIComponent(selection.item.id),
          jsonMutation("PATCH", { ...data, status: selection.action }));
        setSelection(undefined);
        setNotice("Situação atualizada.");
      } else {
        if (quoteId) {
          await request(path + "/quote/" + encodeURIComponent(quoteId), jsonMutation("POST", {
            dueDate: data.dueDate, installments: paymentMode === "single" ? 1 : Number(data.installments),
          }));
        } else {
          await request(path, jsonMutation("POST", { ...data, ...(invoiceId && { invoiceId }) }));
        }
        setPage(1);
        setFilter("");
        setNotice(listing?.account?.provider === "ASAAS" ? "Cobrança planejada. Use Gerar boleto Asaas de teste para criar cada título no Sandbox." : "Cobrança planejada. Registre o boleto no banco e volte para informar a referência.");
      }
      setRevision((value) => value + 1);
    } catch (failure) {
      setError(billingError(failure));
    } finally {
      setBusy(false);
    }
  }

  const selectedAction = selection?.action;
  const canPlan = canWrite && listing?.account && !selection && (companyId ||
    (!listing.items.length && page === 1 && (quoteId ? listing.quote && listing.quote.status !== "CANCELLED" : listing.invoice && !listing.quote)));

  async function runSandbox(item: Boleto) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const operation = path + "/" + encodeURIComponent(item.id) + "/celcoin-sandbox";
      const test = await request<SandboxCharge>(operation + (item.sandbox ? "/consultar" : ""), { method: "POST" });
      setNotice("Celcoin Sandbox · " + sandboxLabels[test.status] + ".");
      setRevision((value) => value + 1);
    } catch (failure) {
      setError(billingError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function runAsaas(item: Boleto, create = false) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const operation = path + "/" + encodeURIComponent(item.id) + "/asaas-sandbox";
      const test = await request<AsaasCharge>(create ? operation : operation + "/consultar", create
        ? jsonMutation("POST", { confirmTest: true }) : { method: "POST" });
      setAsaasSelection(undefined); setNotice("Asaas Sandbox · " + asaasStatusLabel(test.status) + ". Nenhum valor real foi movimentado.");
      setRevision((n) => n + 1);
    } catch (error) { setError(billingError(error)); }
    finally { setBusy(false); }
  }

  return <div className="registry">
    {notice && <p className="registry-notice" role="status">{notice}</p>}
    {error && <div className="registry-card">
      <p className="registry-error" role="alert">{error}</p>
      <button className="button-secondary" onClick={() => { setError(""); setRevision((value) => value + 1); }}>Atualizar lista</button>
    </div>}
    <section className="registry-card">
      <div className="registry-heading">
        <h2>{listing?.company?.legalName ?? (quoteId ? "Cobrança do orçamento" : invoiceId ? "Cobrança da nota" : "Acompanhamento de boletos")}</h2>
        <div className="record-actions">
          {role === "OWNER" && <a href={accountLink}>Conta de recebimento</a>}
          {companyId && <a href="#plataforma">Voltar às empresas</a>}
          {(invoiceId || quoteId) && <a href="#boletos">Todos os boletos</a>}
          {listing?.quote && <a href={"#orcamentos?id=" + encodeURIComponent(listing.quote.id)}>Ver orçamento</a>}
        </div>
      </div>
      <p>{listing?.account?.provider === "ASAAS" ? "Os boletos Asaas desta etapa são de Sandbox. O acompanhamento do teste fica separado da baixa de recebimentos reais." : "Emita o boleto no banco da empresa. Informe a referência do título registrado e confirme a baixa após conferir o crédito."}</p>
      {listing?.account ? <p><strong>Conta cadastrada</strong> · {listing.account.bankName}
        {listing.account.accountLastFour && " · Final " + listing.account.accountLastFour}</p>
        : listing && <p>Cadastre a conta de recebimento para planejar novas cobranças.</p>}
      {listing?.account?.provider === "CELCOIN" && <p><strong>Celcoin Sandbox</strong> · {listing.sandboxConfigured
        ? "Use uma cobrança planejada para gerar um boleto de teste de R$ 10,00 com um pagador fictício."
        : "Aguardando configuração das credenciais de teste no servidor."}</p>}
      {listing?.account?.provider === "ASAAS" && <p><strong>Asaas Sandbox</strong> · {listing.asaasConfigured
        ? "Conexão disponível para gerar e consultar boletos de teste. Não envie esses documentos como cobrança real."
        : "Conecte a conta Asaas em Conta de recebimento antes de continuar."}</p>}
      {listing?.invoice && <p><strong>{listing.invoice.customer.name}</strong> · {currency.format(Number(listing.invoice.amount))}
        {" · "}{listing.invoice.serviceDescription}{listing.invoice.status === "DRAFT" && " · Nota em rascunho"}</p>}
      {listing?.quote && <p><strong>{listing.quote.customerName ?? "Cliente"}</strong> · Total do orçamento {currency.format(Number(listing.quote.amount))}
        {invoiceId && <> · <a href={"#boletos?orcamento=" + encodeURIComponent(listing.quote.id)}>Abrir cobrança do orçamento</a></>}</p>}
      {!companyId && !invoiceId && !quoteId && canWrite && <p>Vincule boletos a um <a href="#orcamentos">orçamento aprovado</a> ou a uma nota em <a href="#clientes">Clientes</a>.</p>}
    </section>
    {asaasSelection && <section className="registry-card">
      <h2>Confirmar boleto Asaas de teste</h2>
      <p>{asaasSelection.payerName} · {currency.format(Number(asaasSelection.amount))} · Vencimento {civilDateLabel(asaasSelection.dueDate)}</p>
      <p>O nome e o documento do pagador serão enviados ao Asaas Sandbox. As notificações ficam desabilitadas. Este título não movimenta dinheiro real.</p>
      <div className="record-actions"><button disabled={busy} onClick={() => void runAsaas(asaasSelection, true)}>Confirmar geração de teste</button>
        <button className="button-secondary" disabled={busy} onClick={() => setAsaasSelection(undefined)}>Voltar</button></div>
    </section>}
    {selection && <form className="registry-card record-form" onSubmit={save}>
      <h2>{selectedAction === "REGISTERED" ? "Informar registro no banco"
        : selectedAction === "SETTLED" ? "Registrar baixa manual" : "Registrar cancelamento"}</h2>
      <p>{selection.item.payerName} · {currency.format(Number(selection.item.amount))}</p>
      <fieldset disabled={busy}>
        {selectedAction === "REGISTERED" && <label>Referência do boleto no banco<input name="issuerReference" required maxLength={100} /></label>}
        {selectedAction === "SETTLED" && <p>Confirme somente depois de conferir o crédito no extrato do banco.</p>}
        {selectedAction === "CANCELLED" && selection.item.status === "REGISTERED" && <p>Confirme o cancelamento no banco antes de atualizar o Fiscal Floow.</p>}
      </fieldset>
      <div className="record-actions">
        <button disabled={busy}>{busy ? "Salvando…" : "Confirmar"}</button>
        <button type="button" className="button-secondary" disabled={busy} onClick={() => setSelection(undefined)}>Voltar</button>
      </div>
    </form>}
    {canPlan &&
      <form className="registry-card record-form" onSubmit={save}>
        <h2>{companyId ? "Planejar cobrança da assinatura" : quoteId ? "Planejar boletos do orçamento" : "Planejar boleto vinculado à nota"}</h2>
        <fieldset disabled={busy}>
          {companyId && <>
            <label>Competência (mês e ano)<input name="period" type="month" required /></label>
            <label>Valor (R$)<input name="amount" inputMode="decimal" required maxLength={15} /></label>
          </>}
          {quoteId && <>
            <label>Forma de pagamento<select value={paymentMode} onChange={(event) =>
              setPaymentMode(event.target.value === "installments" ? "installments" : "single")}>
              <option value="single">À vista</option><option value="installments">Parcelado</option>
            </select></label>
            {paymentMode === "installments" && <label>Parcelas mensais<input type="number" name="installments"
              min={2} max={24} defaultValue={2} required /></label>}
          </>}
          <DateInput label={quoteId && paymentMode === "installments" ? "Primeiro vencimento" : "Vencimento"} name="dueDate" required />
        </fieldset>
        <div className="record-actions"><button disabled={busy}>{busy ? "Salvando…" : "Salvar cobrança"}</button></div>
      </form>}
    <div className="registry-card">
      <div className="registry-heading">
        <h2>Boletos</h2>
        {!invoiceId && !quoteId && <label>Situação <select value={filter} disabled={busy} onChange={(event) => {
          setFilter(event.currentTarget.value); setPage(1); setError("");
        }}>
          <option value="">Todas</option>
          {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>}
      </div>
      {!listing && !error && <p role="status">Carregando boletos…</p>}
      {listing?.items.length === 0 && <p>Nenhum boleto nesta página.</p>}
      {!!listing?.items.length && <div className="registry-table compact-table">
        <table role="table" aria-label="Boletos">
          <thead><tr><th scope="col">Pagador</th><th scope="col">Valor</th><th scope="col">Vencimento</th>
            <th scope="col">Situação</th><th scope="col">Banco e referência</th>{canWrite && <th scope="col">Ações</th>}</tr></thead>
          <tbody role="rowgroup">{listing.items.map((item) => <tr key={item.id} role="row">
            <td role="cell" className="cell-wide"><strong>{item.payerName}</strong>
              {item.period && <div>{month.format(new Date(item.period + "-01"))}</div>}
              {item.quoteId && <div>{item.installments === 1 ? "À vista" : `Parcela ${item.installment} de ${item.installments}`}
                {!quoteId && !invoiceId && <> · <a href={"#boletos?orcamento=" + encodeURIComponent(item.quoteId)}>Ver orçamento da cobrança</a></>}</div>}
              {item.invoiceId && !invoiceId && <div><a href={"#boletos?nota=" + encodeURIComponent(item.invoiceId)}>Ver vínculo com a nota</a></div>}
            </td>
            <td role="cell" data-label="Valor">{currency.format(Number(item.amount))}</td>
            <td role="cell" data-label="Vencimento">{civilDateLabel(item.dueDate)}</td>
            <td role="cell" data-label="Situação">{item.asaas ? "Asaas Sandbox · " + asaasStatusLabel(item.asaas.overdue ? "OVERDUE" : item.asaas.status) : labels[item.overdue ? "OVERDUE" : item.status]}</td>
            <td role="cell" data-label="Banco e referência" className="cell-wide">{item.bankName}{item.accountLastFour && " · Final " + item.accountLastFour}
              {item.issuerReference && <div>{item.issuerReference}</div>}
              {item.sandbox && <div>
                <strong>Celcoin Sandbox · {item.sandbox.overdue ? "Atrasado" : sandboxLabels[item.sandbox.status]}</strong>
                <div>{currency.format(Number(item.sandbox.amount))} · Vence em {civilDateLabel(item.sandbox.dueDate)}</div>
                {item.sandbox.bankLine && <details><summary>Linha digitável de teste</summary>
                  <code className="invoice-access-key">{item.sandbox.bankLine}</code>
                </details>}
              </div>}
              {item.asaas && <div>
                {item.asaas.errorCode && <p>Retorno pendente de conferência. Consulte o teste antes de qualquer nova criação.</p>}
                {item.asaas.bankSlipUrl && <a className="button button-secondary asaas-document-link" href={item.asaas.bankSlipUrl} target="_blank" rel="noopener noreferrer">Abrir PDF do boleto de teste</a>}
                {item.asaas.invoiceUrl && <div><a href={item.asaas.invoiceUrl} target="_blank" rel="noopener noreferrer">Ver fatura de teste no Asaas</a></div>}
              </div>}
            </td>
            {canWrite && <td role="cell" className="cell-wide"><div className="record-actions">
              {item.provider !== "ASAAS" && item.status === "PLANNED" && <button className="button-secondary" disabled={busy}
                onClick={() => setSelection({ item, action: "REGISTERED" })}>Informar registro</button>}
              {item.provider !== "ASAAS" && item.status === "REGISTERED" && <button className="button-secondary" disabled={busy}
                onClick={() => setSelection({ item, action: "SETTLED" })}>Dar baixa</button>}
              {!item.asaas && (item.status === "PLANNED" || item.status === "REGISTERED") && <button className="button-secondary" disabled={busy}
                onClick={() => setSelection({ item, action: "CANCELLED" })}>Cancelar boleto</button>}
              {listing.sandboxConfigured && (item.sandbox ||
                (item.status === "PLANNED" && item.provider === "CELCOIN" && listing.account?.provider === "CELCOIN")) &&
                <button className="button-secondary" disabled={busy} onClick={() => void runSandbox(item)}>
                  {item.sandbox ? "Consultar teste Celcoin" : "Gerar boleto de teste"}
                </button>}
              {listing.asaasConfigured && item.provider === "ASAAS" && (item.asaas ||
                (item.status === "PLANNED" && listing.account?.provider === "ASAAS")) && <button className="button-secondary" disabled={busy}
                  onClick={() => item.asaas ? void runAsaas(item) : setAsaasSelection(item)}>
                    {item.asaas ? "Consultar teste Asaas" : "Gerar boleto Asaas de teste"}
                </button>}
            </div></td>}
          </tr>)}</tbody>
        </table>
      </div>}
      {listing && (page > 1 || listing.hasNext) && <div className="record-actions registry-pagination">
        <button className="button-secondary" disabled={page === 1 || busy} onClick={() => setPage(page - 1)}>Anterior</button>
        <span>Página {page}</span>
        <button className="button-secondary" disabled={!listing.hasNext || page >= 10000 || busy} onClick={() => setPage(page + 1)}>Próxima</button>
      </div>}
    </div>
  </div>;
}
