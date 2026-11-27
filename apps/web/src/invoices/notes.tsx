import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, jsonMutation, RegistrationError, useRegistrationRequest, type PageAccess } from "../registrations/api";
import { CatalogPicker, type CatalogOption } from "./catalog-picker";
import { InvoiceHistoryPage } from "./customer-history";
import { NewInvoice } from "./drafts";
import { invoiceKindLabels, monthlyKinds, type MonthlyKind } from "./kinds";
import { Icon } from "../ui";
import { AutomaticSchedulePanel } from "./automatic-schedules";
import { MonthlyDescriptionOption } from "./monthly-description";

function MonthlySetup({ access, initialCustomerId }: { access: PageAccess; initialCustomerId?: string }) {
  const request = useRegistrationRequest(access.organizationId, access.endSession);
  const [customer, setCustomer] = useState<CatalogOption>();
  const [service, setService] = useState<CatalogOption>();
  const [kind, setKind] = useState<MonthlyKind>("MENSALIDADE");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [previousMonthDescription, setPreviousMonthDescription] = useState(false);
  const [contractName, setContractName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nextRun, setNextRun] = useState<string | null | undefined>();
  const [automaticRequested, setAutomaticRequested] = useState(false);
  const [automaticId, setAutomaticId] = useState<string>();

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
      const saved = await request<{ id: string; nextRunAt: string | null }>("schedules/monthly", jsonMutation("POST", {
        customerId: customer.id, serviceId: service.id, kind, amount, serviceDescription: description, contractName, previousMonthDescription,
      }));
      setNextRun(saved.nextRunAt);
      if (automaticRequested) setAutomaticId(saved.id);
    } catch (failure) {
      setError(failure instanceof RegistrationError && failure.code === "schedule-exists"
        ? "Já existe uma nota mensal para este cliente, contrato e tipo. Abra Recorrências para ajustar."
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
        <label>Contrato ou unidade (opcional)<input value={contractName} maxLength={160} placeholder="Ex.: CEI NOVO IPÊ"
          onChange={(event) => setContractName(event.target.value)} /><small className="record-hint">Use nomes diferentes para programar notas separadas no mesmo CPF ou CNPJ.</small></label>
        <label>Valor (R$)<input value={amount} inputMode="decimal" maxLength={15} required onChange={(event) => setAmount(event.target.value)} /></label>
        <label>Descrição do serviço<textarea value={description} rows={3} maxLength={2000} required onChange={(event) => setDescription(event.target.value)} /></label>
        <MonthlyDescriptionOption enabled={previousMonthDescription} description={description} toggle={setPreviousMonthDescription} changeDescription={setDescription} />
      </fieldset>
      {access.role === "OWNER" && <label className="checkbox-field"><input type="checkbox" checked={automaticRequested} disabled={busy} onChange={(e) => setAutomaticRequested(e.currentTarget.checked)} />Quero conferir os dados fiscais e autorizar a emissão automática no dia 1.</label>}
      <div className="record-actions"><button disabled={busy || !customer || !service}>{busy ? "Salvando…" : "Salvar nota mensal"}</button></div>
      {automaticId && <AutomaticSchedulePanel id={automaticId} request={request} close={() => setAutomaticId(undefined)} saved={() => { setAutomaticId(undefined); window.location.hash = "recorrencias"; }} />}
    </form>
  );
}

export function NotesPage({ access, query }: { access: PageAccess; query: URLSearchParams }) {
  const canManage = access.role === "OWNER" || access.role === "ADMIN";
  const canDraft = canManage || access.role === "OPERATOR";
  const customer = query.get("cliente") ?? undefined;
  const mode = customer ? "mensal" : query.get("nova");
  if (mode === "avulsa" && canDraft) {
    return <div className="registry"><NewInvoice {...access} invoiceId={query.get("nota") ?? undefined}
      competence={query.get("competencia") ?? undefined} /></div>;
  }
  return (
    <div className="registry">
      <div className="note-launch">
        <section className="note-launch-main">
          <span className="note-launch-eyebrow"><Icon name="document" />NFS-e Nacional</span>
          <h2>Sua emissão, do começo ao PDF.</h2>
          <p>Selecione o cliente, informe o serviço e confira os dados antes de autorizar a emissão.</p>
          {canDraft && <a className="button" href="#notas-fiscais?nova=avulsa"><Icon name="plus" />Nova nota avulsa<Icon name="arrow" /></a>}
        </section>
        <section className="note-launch-monthly">
          <span className="collection-icon"><Icon name={canManage ? "repeat" : "download"} /></span>
          <h2>{canManage ? "Mensalidades organizadas" : "Seus documentos reunidos"}</h2>
          <p>{canManage ? "Configure os contratos e revise cada programação em Recorrências." : "Consulte o histórico abaixo e baixe os documentos disponíveis de cada nota."}</p>
          {canManage && <a className="button button-secondary" href="#notas-fiscais?nova=mensal">Configurar nota mensal<Icon name="arrow" /></a>}
        </section>
      </div>
      <nav className="note-shortcuts" aria-label="Atalhos de notas fiscais">
        <a href="#rascunhos"><Icon name="drafts" />Consultar rascunhos</a>
        {canManage && <a href="#recorrencias"><Icon name="repeat" />Gerenciar recorrências</a>}
      </nav>
      {mode === "mensal" && canManage && <MonthlySetup key={customer ?? "monthly"} access={access} initialCustomerId={customer} />}
      <InvoiceHistoryPage {...access} />
    </div>
  );
}
