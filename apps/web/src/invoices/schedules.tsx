import { timestampLabel } from "../format";
import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, jsonMutation, RegistrationError, useRegistrationRequest, type PageAccess, type RecordData } from "../registrations/api";
import { CatalogPicker, type CatalogOption } from "./catalog-picker";
import { invoiceKindLabels, monthlyKinds, type MonthlyKind } from "./kinds";

type Schedule = {
  id: string;
  dayOfMonth: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  pauseReason: string | null;
  kind: MonthlyKind;
  sourceInvoiceId: string | null;
  serviceId: string | null;
  service: { name: string } | null;
  customer: { name: string };
  serviceDescription: string;
  amount: string;
};
type Listing = { items: Schedule[]; hasNext: boolean };
type Request = ReturnType<typeof useRegistrationRequest>;
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function scheduleError(failure: unknown) {
  if (failure instanceof RegistrationError) {
    if (failure.code === "schedule-exists") return "Já existe uma recorrência para este rascunho. Abra Recorrências para ajustá-la.";
    if (failure.code === "draft-unavailable") return "O rascunho saiu da lista. Atualize a página.";
    if (failure.code === "customer-unavailable") return "O cliente cadastrado está indisponível.";
    if (failure.code === "service-unavailable") return "O serviço cadastrado está indisponível.";
    if (failure.code === "duplicate-registration") return "Este cliente já tem uma nota mensal desse tipo.";
  }
  return errorMessage(failure);
}

function ScheduleForm({ title, plan, request, save, close }: {
  title: string;
  plan?: Schedule;
  request: Request;
  save: (day: number, active: boolean, changes: RecordData) => Promise<void>;
  close: () => void;
}) {
  const [day, setDay] = useState(String(plan?.dayOfMonth ?? 1));
  const [active, setActive] = useState(plan ? Boolean(plan.nextRunAt) : true);
  const [kind, setKind] = useState<MonthlyKind>(plan?.kind ?? "MENSALIDADE");
  const [amount, setAmount] = useState(plan?.amount ?? "");
  const [description, setDescription] = useState(plan?.serviceDescription ?? "");
  const [service, setService] = useState<CatalogOption | undefined>(plan?.serviceId && plan.service
    ? { id: plan.serviceId, name: plan.service.name } : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const changes: RecordData = {};
      if (kind !== plan?.kind) changes.kind = kind;
      if (plan && amount !== plan.amount) changes.amount = amount;
      if (plan && description !== plan.serviceDescription) changes.serviceDescription = description;
      if (plan && service && service.id !== plan.serviceId) changes.serviceId = service.id;
      await save(Number(day), active, changes);
    } catch (failure) {
      setError(scheduleError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="record-form registry-card" onSubmit={submit}>
      <h2>{title}</h2>
      <p>{plan?.sourceInvoiceId === null
        ? "Esta nota mensal gera um rascunho no dia 1, às 8h de Brasília."
        : "A recorrência prepara um rascunho às 8h, no horário de Brasília. Se o mês for mais curto, usa o último dia."}</p>
      {plan?.sourceInvoiceId !== null && <label>Dia do mês
        <input type="number" value={day} onChange={(event) => setDay(event.target.value)} min={1} max={31} step={1} required disabled={busy} />
      </label>}
      <label>Tipo de nota
        <select value={kind} onChange={(event) => setKind(event.target.value as MonthlyKind)} disabled={busy}>
          {monthlyKinds.map((value) => <option key={value} value={value}>{invoiceKindLabels[value]}</option>)}
        </select>
      </label>
      {plan && <fieldset disabled={busy}>
        <CatalogPicker request={request} resource="services" label="Serviço" value={service?.id ?? ""} initial={service}
          required={plan.sourceInvoiceId === null} onChange={(selected) => {
            if (selected) setService(selected);
          }} />
        <label>Valor (R$)<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} maxLength={15} required /></label>
        <label>Descrição<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={2000} required /></label>
      </fieldset>}
      {plan && (
        <label className="record-checkbox">
          <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} disabled={busy} /> Recorrência ativa
        </label>
      )}
      {error && <p className="registry-error" role="alert">{error}</p>}
      <div className="record-actions">
        <button disabled={busy}>{busy ? "Salvando…" : "Salvar recorrência"}</button>
        <button type="button" className="button-secondary" disabled={busy} onClick={close}>Cancelar</button>
      </div>
    </form>
  );
}

export function CreateScheduleForm({ draftId, customerName, request, onSaved, close }: {
  draftId: string; customerName: string; request: Request; onSaved: () => void; close: () => void;
}) {
  return <ScheduleForm title={"Criar recorrência para " + customerName} request={request} close={close}
    save={async (day, _active, changes) => {
      await request("schedules", jsonMutation("POST", { draftId, dayOfMonth: day, ...changes }));
      onSaved();
    }} />;
}

export function InvoiceSchedulesPage({ organizationId, endSession }: PageAccess) {
  const request = useRegistrationRequest(organizationId, endSession);
  const [listing, setListing] = useState<Listing>();
  const [editing, setEditing] = useState<Schedule>();
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setListing(undefined);
    setError("");
    request<Listing>("schedules?page=" + page, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setListing(data); })
      .catch((failure) => { if (!controller.signal.aborted) setError(scheduleError(failure)); });
    return () => controller.abort();
  }, [request, page, version]);

  return (
    <div className="registry">
      {notice && <p className="registry-notice" role="status">{notice}</p>}
      {editing && (
        <ScheduleForm key={editing.id} title={"Recorrência de " + editing.customer.name} plan={editing}
          request={request} close={() => setEditing(undefined)}
          save={async (day, active, changes) => {
            await request("schedules/" + encodeURIComponent(editing.id), jsonMutation("PATCH", { active, dayOfMonth: day, ...changes }));
            setEditing(undefined);
            setVersion((current) => current + 1);
            setNotice(active ? "Recorrência salva." : "Recorrência pausada.");
          }} />
      )}
      <div className="registry-card">
        <h2>Preparação mensal de rascunhos</h2>
        <p>Configure uma <a href="#notas-fiscais?nova=mensal">nota mensal no dia 1</a> ou crie uma recorrência a partir de um <a href="#rascunhos">rascunho salvo</a>.</p>
        {error && <><p className="registry-error" role="alert">{error}</p><button className="button-secondary" onClick={() => setVersion((current) => current + 1)}>Tentar novamente</button></>}
        {!listing && !error && <p role="status">Carregando recorrências…</p>}
        {listing && (listing.items.length ? (
          <div className="registry-table">
            <table aria-label="Recorrências da empresa">
              <thead><tr><th scope="col">Cliente</th><th scope="col">Tipo</th><th scope="col">Descrição</th><th scope="col">Valor</th><th scope="col">Dia</th><th scope="col">Próximo rascunho</th><th scope="col">Última execução</th><th scope="col">Ações</th></tr></thead>
              <tbody>{listing.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.customer.name}</td><td>{invoiceKindLabels[item.kind]}</td><td>{item.serviceDescription}</td><td>{currency.format(Number(item.amount))}</td>
                  <td>{item.dayOfMonth}</td>
                  <td>{item.nextRunAt ? timestampLabel(item.nextRunAt) : (
                    item.pauseReason === "customer-unavailable" ? "Pausada · cliente indisponível" :
                      item.pauseReason === "service-unavailable" ? "Pausada · serviço indisponível" : "Pausada"
                  )}</td>
                  <td>{item.lastRunAt ? timestampLabel(item.lastRunAt) : "—"}</td>
                  <td><button className="button-secondary" disabled={Boolean(editing)} onClick={() => { setEditing(item); setNotice(""); }}>Configurar</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p>Nenhuma recorrência nesta página.</p>)}
        {listing && (page > 1 || listing.hasNext) && (
          <div className="record-actions registry-pagination">
            <button className="button-secondary" disabled={page === 1 || Boolean(editing)} onClick={() => setPage(page - 1)}>Anterior</button>
            <span>Página {page}</span>
            <button className="button-secondary" disabled={!listing.hasNext || page >= 10000 || Boolean(editing)} onClick={() => setPage(page + 1)}>Próxima</button>
          </div>
        )}
      </div>
    </div>
  );
}
