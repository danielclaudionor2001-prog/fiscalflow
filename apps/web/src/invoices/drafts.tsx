import { dateLabel } from "../format";
import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, jsonMutation, RegistrationError, useRegistrationRequest, type PageAccess } from "../registrations/api";
import { InvoiceActivity } from "./activity";
import { CatalogPicker } from "./catalog-picker";
import { invoiceKindLabels, type InvoiceKind } from "./kinds";
import { PrepareDpsForm } from "./prepare-dps";
import { CreateScheduleForm } from "./schedules";

type Request = ReturnType<typeof useRegistrationRequest>;
type Page<T> = { items: T[]; hasNext: boolean };
type Draft = {
  id: string;
  kind: InvoiceKind;
  customerId: string;
  serviceId: string | null;
  customer: { name: string };
  service: { name: string } | null;
  serviceDescription: string;
  amount: string;
  createdAt: string;
  updatedAt: string;
};
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function draftSaveError(error: unknown) {
  if (error instanceof RegistrationError) {
    if (error.code === "customer-unavailable") return "Escolha um cliente disponível nesta empresa.";
    if (error.code === "service-unavailable") return "Escolha um serviço ativo desta empresa.";
    if (error.code === "idempotency-conflict") return "Já existe um rascunho para este pedido. Volte à lista para conferi-lo.";
    if (error.code === "draft-changed") return "O rascunho mudou. Volte à lista para abrir a versão mais recente.";
    if (error.code === "draft-unavailable") return "Esse rascunho saiu da lista. Atualize a página para conferir.";
    if (error.status === 400) return "Informe o cliente, a descrição e um valor maior que zero.";
  }
  return errorMessage(error);
}

function DraftForm({ request, draft, onSaved, onClose }: { request: Request; draft?: Draft; onSaved: () => void; onClose: () => void }) {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [customerId, setCustomerId] = useState(draft?.customerId ?? "");
  const [serviceId, setServiceId] = useState(draft?.serviceId ?? "");
  const [amount, setAmount] = useState(draft?.amount ?? "");
  const [description, setDescription] = useState(draft?.serviceDescription ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const mutation = jsonMutation(draft ? "PATCH" : "POST", { customerId, serviceId: serviceId || null, amount, serviceDescription: description });
    const headers = new Headers(mutation.headers);
    if (draft) headers.set("If-Match", `"${draft.updatedAt}"`);
    else headers.set("Idempotency-Key", idempotencyKey);
    try {
      await request(draft ? `invoices/${encodeURIComponent(draft.id)}` : "invoices", { ...mutation, headers });
      onSaved();
    } catch (failure) {
      setError(draftSaveError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="registry-card">
      <div className="registry-heading"><h2>{draft ? "Editar rascunho" : "Novo rascunho"}</h2></div>
      <form className="record-form" onSubmit={save}>
        {error && <p role="alert" className="registry-error">{error}</p>}
        <fieldset disabled={busy}>
          <CatalogPicker request={request} resource="customers" label="Cliente" value={customerId}
            initial={draft ? { id: draft.customerId, name: draft.customer.name } : undefined}
            onChange={(option) => setCustomerId(option?.id ?? "")} />
          <CatalogPicker request={request} resource="services" label="Serviço (opcional)" value={serviceId}
            initial={draft?.service && draft.serviceId ? {
              id: draft.serviceId, name: draft.service.name, defaultAmount: draft.amount, description: draft.serviceDescription,
            } : undefined} onChange={(option) => {
            setServiceId(option?.id ?? "");
            if (option) {
              setAmount(option.defaultAmount ?? "");
              setDescription(option.description ?? "");
            }
          }} />
          <label>Descrição do serviço<textarea value={description} required maxLength={2000} rows={3} onChange={(event) => setDescription(event.target.value)} /></label>
          <label>Valor (R$)<input inputMode="decimal" value={amount} required maxLength={15} onChange={(event) => setAmount(event.target.value)} /></label>
        </fieldset>
        <div className="record-actions">
          <button type="submit" disabled={busy || !customerId}>{busy ? "Salvando…" : "Salvar rascunho"}</button>
          <button type="button" className="button-secondary" disabled={busy} onClick={onClose}>Voltar à lista</button>
        </div>
      </form>
    </div>
  );
}

export function InvoiceDraftsPage({ role, organizationId, endSession, startNew = false }: PageAccess & { startNew?: boolean }) {
  const request = useRegistrationRequest(organizationId, endSession);
  const [editor, setEditor] = useState<"create" | Draft | undefined>(startNew ? "create" : undefined);
  const [preparing, setPreparing] = useState<Draft>();
  const [discarding, setDiscarding] = useState<Draft>();
  const [scheduling, setScheduling] = useState<Draft>();
  const [discardBusy, setDiscardBusy] = useState(false);
  const [discardError, setDiscardError] = useState("");
  const [showActivity, setShowActivity] = useState(false);
  const [listing, setListing] = useState<Page<Draft>>();
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canDiscard = role === "OWNER" || role === "ADMIN";
  const canWrite = canDiscard || role === "OPERATOR";
  const actionOpen = Boolean(editor || discarding || scheduling || preparing);

  useEffect(() => {
    const controller = new AbortController();
    setListing(undefined);
    setError("");
    request<Page<Draft>>(`invoices?page=${page}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setListing(data); })
      .catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [page, request, version]);

  function closeActions() {
    setEditor(undefined);
    setDiscarding(undefined);
    setScheduling(undefined);
    setVersion((current) => current + 1);
  }

  async function discard() {
    if (!discarding || discardBusy) return;
    setDiscardBusy(true);
    setDiscardError("");
    try {
      await request(`invoices/${encodeURIComponent(discarding.id)}`, {
        method: "DELETE",
        headers: { "If-Match": `"${discarding.updatedAt}"` },
      });
      closeActions();
      setNotice("Rascunho excluído.");
      if (listing?.items.length === 1 && page > 1) setPage(page - 1);
    } catch (failure) {
      setDiscardError(draftSaveError(failure));
    } finally {
      setDiscardBusy(false);
    }
  }

  return (
    <div className="registry">
      {notice && <p className="registry-notice" role="status">{notice}</p>}
      {editor && canWrite && (
        <DraftForm key={editor === "create" ? "create" : editor.id} request={request} draft={editor === "create" ? undefined : editor}
          onClose={closeActions} onSaved={() => {
          closeActions();
          setNotice("Rascunho salvo.");
          if (editor === "create") setPage(1);
        }} />
      )}
      {discarding && canDiscard && (
        <div className="archive-confirmation">
          <p>Excluir o rascunho de <strong>{discarding.customer.name}</strong> no valor de {currency.format(Number(discarding.amount))}?</p>
          {discardError && <p role="alert">{discardError}</p>}
          <div className="record-actions">
            <button className="button-danger" disabled={discardBusy} onClick={discard}>{discardBusy ? "Excluindo…" : "Confirmar exclusão"}</button>
            <button className="button-secondary" disabled={discardBusy} onClick={closeActions}>Cancelar</button>
          </div>
        </div>
      )}
      {scheduling && canDiscard && (
        <CreateScheduleForm key={scheduling.id} draftId={scheduling.id} customerName={scheduling.customer.name}
          request={request} close={() => setScheduling(undefined)} onSaved={() => {
            setScheduling(undefined);
            setNotice("Recorrência configurada. Consulte a próxima data em Recorrências.");
          }} />
      )}
      {preparing && canWrite && <PrepareDpsForm key={preparing.id} draftId={preparing.id} request={request} close={() => setPreparing(undefined)} />}
      <div className="registry-card">
        <div className="registry-heading">
          <h2>Rascunhos da empresa</h2>
          <div className="record-actions">
            {canDiscard && <button className="button-secondary" aria-expanded={showActivity} aria-controls="invoice-activity"
              onClick={() => setShowActivity(!showActivity)}>{showActivity ? "Ocultar histórico" : "Ver histórico"}</button>}
            {canWrite && !actionOpen && <button onClick={() => { setEditor("create"); setNotice(""); }}>Novo rascunho</button>}
          </div>
        </div>
        {error && <><p role="alert" className="registry-error">{error}</p><button className="button-secondary" onClick={() => setVersion((current) => current + 1)}>Tentar novamente</button></>}
        {!listing && !error && <p role="status">Carregando rascunhos…</p>}
        {listing && (listing.items.length === 0 ? <p>Nenhum rascunho nesta página.</p> : (
          <div className="registry-table compact-table">
            <table role="table" aria-label="Rascunhos da empresa">
              <thead><tr><th scope="col">Cliente</th><th scope="col">Tipo</th><th scope="col">Serviço</th><th scope="col">Descrição</th><th scope="col">Valor</th><th scope="col">Criado em</th>{canWrite && <th scope="col">Ações</th>}</tr></thead>
              <tbody role="rowgroup">{listing.items.map((item) => (
                <tr role="row" key={item.id}>
                  <td role="cell" className="cell-wide" data-label="Cliente">{item.customer.name}</td>
                  <td role="cell" data-label="Tipo">{invoiceKindLabels[item.kind]}</td>
                  <td role="cell" data-label="Serviço">{item.service?.name ?? "—"}</td>
                  <td role="cell" className="cell-wide" data-label="Descrição">{item.serviceDescription}</td>
                  <td role="cell" data-label="Valor">{currency.format(Number(item.amount))}</td>
                  <td role="cell" data-label="Criado em">{dateLabel(item.createdAt)}</td>
                  {canWrite && <td role="cell" className="cell-wide"><div className="record-actions">
                    {canDiscard && <a href={"#boletos?nota=" + encodeURIComponent(item.id)}>Ver cobrança</a>}
                    <button className="button-secondary" disabled={actionOpen} onClick={() => {
                      setPreparing(item);
                      setNotice("");
                    }}>Preparar DPS</button>
                    <button className="button-secondary" disabled={actionOpen} onClick={() => {
                      setEditor(item);
                      setNotice("");
                    }}>Editar</button>
                    {canDiscard && <button className="button-secondary" disabled={actionOpen} onClick={() => {
                      setDiscarding(item);
                      setDiscardError("");
                      setNotice("");
                    }}>Excluir</button>}
                    {canDiscard && <button className="button-secondary" disabled={actionOpen} onClick={() => {
                      setScheduling(item);
                      setNotice("");
                    }}>Criar recorrência</button>}
                  </div></td>}
                </tr>
              ))}</tbody>
            </table>
          </div>
        ))}
        {listing && (page > 1 || listing.hasNext) && (
          <div className="record-actions registry-pagination">
            <button className="button-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
            <span>Página {page}</span>
            <button className="button-secondary" disabled={!listing.hasNext || page >= 10000} onClick={() => setPage(page + 1)}>Próxima</button>
          </div>
        )}
      </div>
      {canDiscard && showActivity && <InvoiceActivity key={version} request={request} />}
    </div>
  );
}
