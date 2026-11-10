import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, jsonMutation, RegistrationError, useRegistrationRequest, type PageAccess } from "../registrations/api";
import { CatalogPicker, type CatalogOption } from "./catalog-picker";
import { InvoiceDraftsPage } from "./drafts";
import { invoiceKindLabels, monthlyKinds, type MonthlyKind } from "./kinds";
import { Icon } from "../ui";

function MonthlySetup({ access, initialCustomerId }: { access: PageAccess; initialCustomerId?: string }) {
  const request = useRegistrationRequest(access.organizationId, access.endSession);
  const [customer, setCustomer] = useState<CatalogOption>();
  const [service, setService] = useState<CatalogOption>();
  const [kind, setKind] = useState<MonthlyKind>("MENSALIDADE");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nextRun, setNextRun] = useState<string | null | undefined>();

  useEffect(() => {
    if (!initialCustomerId) return;
    const controller = new AbortController();
    request<CatalogOption>("customers/" + encodeURIComponent(initialCustomerId), { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setCustomer((current) => current ?? data); })
      .catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [request, initialCustomerId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !customer || !service) return;
    setBusy(true);
    setError("");
    setNextRun(undefined);
    try {
      const saved = await request<{ nextRunAt: string | null }>("schedules/monthly", jsonMutation("POST", {
        customerId: customer.id, serviceId: service.id, kind, amount, serviceDescription: description,
      }));
      setNextRun(saved.nextRunAt);
    } catch (failure) {
      setError(failure instanceof RegistrationError && failure.code === "schedule-exists"
        ? "Já existe uma nota mensal desse tipo para este cliente. Abra Recorrências para ajustar."
        : errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="record-form registry-card" onSubmit={submit}>
      <h2>Configurar nota mensal</h2>
      <p>O Fiscal Floow prepara um rascunho no dia 1 de cada mês, às 8h de Brasília.</p>
      {error && <p className="registry-error" role="alert">{error}</p>}
      {nextRun !== undefined && <p className="registry-notice" role="status">
        {nextRun ? "Nota mensal configurada." : "Esta nota mensal está pausada."} <a href="#recorrencias">Abrir recorrências</a>
      </p>}
      <fieldset disabled={busy}>
        <CatalogPicker request={request} resource="customers" label="Cliente" value={customer?.id ?? ""} initial={customer} onChange={setCustomer} />
        <CatalogPicker request={request} resource="services" label="Serviço" value={service?.id ?? ""} initial={service} required onChange={(selected) => {
          setService(selected);
          setAmount(selected?.defaultAmount ?? "");
          setDescription(selected?.description ?? "");
        }} />
        <label>Tipo da nota mensal
          <select value={kind} onChange={(event) => setKind(event.target.value as MonthlyKind)}>
            {monthlyKinds.map((value) => <option key={value} value={value}>{invoiceKindLabels[value]}</option>)}
          </select>
        </label>
        <label>Valor (R$)<input value={amount} inputMode="decimal" maxLength={15} required onChange={(event) => setAmount(event.target.value)} /></label>
        <label>Descrição do serviço<textarea value={description} rows={3} maxLength={2000} required onChange={(event) => setDescription(event.target.value)} /></label>
      </fieldset>
      <div className="record-actions"><button disabled={busy || !customer || !service}>{busy ? "Salvando…" : "Salvar nota mensal"}</button></div>
    </form>
  );
}

export function NotesPage({ access, query }: { access: PageAccess; query: URLSearchParams }) {
  const canManage = access.role === "OWNER" || access.role === "ADMIN";
  const canDraft = canManage || access.role === "OPERATOR";
  const customer = query.get("cliente") ?? undefined;
  const mode = customer ? "mensal" : query.get("nova");
  return (
    <div className="registry">
      <div className="registry-card">
        <h2>Preparação de NFS-e</h2>
        <p>Escolha uma nota avulsa ou configure a preparação mensal de rascunhos. A transmissão fiscal depende da homologação.</p>
        <div className="record-actions">
          {canDraft && <a className="button" href="#notas-fiscais?nova=avulsa"><Icon name="plus" />Nova nota avulsa</a>}
          {canManage && <a className="button button-secondary" href="#notas-fiscais?nova=mensal"><Icon name="repeat" />Configurar nota mensal</a>}
          <a href="#rascunhos">Consultar rascunhos</a>
          {canManage && <a href="#recorrencias">Gerenciar recorrências</a>}
        </div>
      </div>
      {mode === "avulsa" && canDraft && <InvoiceDraftsPage {...access} startNew />}
      {mode === "mensal" && canManage && <MonthlySetup key={customer ?? "monthly"} access={access} initialCustomerId={customer} />}
    </div>
  );
}
