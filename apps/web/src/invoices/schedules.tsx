import { timestampLabel } from "../format";
import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, jsonMutation, RegistrationError, useRegistrationRequest, type PageAccess, type RecordData } from "../registrations/api";
import { CatalogPicker, type CatalogOption } from "./catalog-picker";
import { invoiceKindLabels, monthlyKinds, type MonthlyKind } from "./kinds";
import { AutomaticSchedulePanel, automaticMessages } from "./automatic-schedules";
import { Icon } from "../ui";
import "./schedules.css";

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
  automaticProduction: boolean;
  automaticRuns: { period: string; status: string; errorCode: string | null; invoiceId: string }[];
};
type Summary = { total: number; active: number; paused: number; automatic: number; amount: string };
type Listing = { items: Schedule[]; hasNext: boolean; matching: number; summary: Summary };
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
      {plan?.automaticProduction && <p className="registry-error">Salvar alterações interrompe a autorização automática desta programação. Confira os dados e autorize novamente para voltar a emitir sem revisão mensal.</p>}
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

export function InvoiceSchedulesPage({ organizationId, endSession, role }: PageAccess) {
  const request = useRegistrationRequest(organizationId, endSession);
  const [listing, setListing] = useState<Listing>();
  const [editing, setEditing] = useState<Schedule>();
  const [automatic, setAutomatic] = useState<string>();
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("");
  const [sort, setSort] = useState("name_asc");
  const [summary, setSummary] = useState<Summary>();
  useEffect(() => {
    const timer = window.setTimeout(() => { setPage(1); setQuery(search.trim()); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    setListing(undefined);
    setError("");
    const params = new URLSearchParams({ page: String(page), status, sort });
    if (query) params.set("q", query);
    if (kind) params.set("kind", kind);
    request<Listing>("schedules?" + params, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) { setListing(data); setSummary(data.summary); } })
      .catch((failure) => { if (!controller.signal.aborted) setError(scheduleError(failure)); });
    return () => controller.abort();
  }, [request, page, version, query, status, kind, sort]);

  return (
    <div className="registry schedules-page">
      <section className="schedules-hero" aria-label="Gestão das recorrências">
        <div className="schedules-hero-copy">
          <span className="schedules-eyebrow"><Icon name="repeat" /> ROTINA MENSAL</span>
          <h2>Seu mês organizado.<br />Cada cliente no controle.</h2>
          <p>Reúna contratos, confira os valores e acompanhe suas programações em um só lugar.</p>
          <a className="button" href="#notas-fiscais?nova=mensal"><Icon name="plus" /> Nova programação mensal</a>
        </div>
        <div className="schedules-hero-calendar" aria-hidden="true">
          <span>Planejamento recorrente</span><strong>01</strong><span>Um novo mês, tudo organizado</span>
          <div><Icon name="clients" /><i /><Icon name="repeat" /><i /><Icon name="document" /></div>
        </div>
      </section>
      <section className="schedules-stats" aria-label="Resumo de todas as recorrências">
        <div className="schedules-stat"><span className="schedules-stat-icon"><Icon name="repeat" /></span><div><span>Programações</span><strong>{summary?.total ?? "—"}</strong><small>Todos os contratos cadastrados</small></div></div>
        <div className="schedules-stat"><span className="schedules-stat-icon schedules-icon-amber"><Icon name="clock" /></span><div><span>Pausadas</span><strong>{summary?.paused ?? "—"}</strong><small>Sem execução agendada</small></div></div>
        <div className="schedules-stat"><span className="schedules-stat-icon schedules-icon-green"><Icon name="shield" /></span><div><span>Emissão automática ativa</span><strong>{summary?.automatic ?? "—"}</strong><small>Programações com autorização</small></div></div>
        <div className="schedules-stat schedules-stat-value"><span className="schedules-stat-icon"><Icon name="report" /></span><div><span>Valor das programações</span><strong>{summary ? currency.format(Number(summary.amount)) : "—"}</strong><small>Inclui pausadas; não é valor emitido</small></div></div>
      </section>
      {notice && <p className="registry-notice" role="status">{notice}</p>}
      {automatic && <AutomaticSchedulePanel key={automatic} id={automatic} request={request} close={() => setAutomatic(undefined)} saved={() => {
        setAutomatic(undefined); setVersion((current) => current + 1); setNotice("Configuração de emissão automática salva. Nenhuma nota foi enviada agora.");
      }} />}
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
      <section className="registry-card schedules-list" aria-label="Programações mensais">
        <div className="schedules-list-heading"><div><h2>Suas programações</h2><p>Encontre um cliente e confira cada contrato antes de autorizar.</p></div><span className="schedules-count" role="status">{listing ? `${listing.matching} ${listing.matching === 1 ? "programação" : "programações"}` : "Carregando…"}</span></div>
        <div className="record-form schedules-filters">
          <label className="schedules-search">Buscar cliente<input type="search" placeholder="Digite o nome do cliente" maxLength={120} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <label>Situação<select value={status} onChange={(event) => { setPage(1); setStatus(event.target.value); }}>
            <option value="all">Todas as situações</option><option value="paused">Pausadas</option><option value="active">Ativas</option><option value="automatic">Emissão automática ativa</option>
          </select></label>
          <label>Tipo<select value={kind} onChange={(event) => { setPage(1); setKind(event.target.value); }}>
            <option value="">Todos os tipos</option>{monthlyKinds.map((value) => <option key={value} value={value}>{invoiceKindLabels[value]}</option>)}
          </select></label>
          <label>Ordenar por<select value={sort} onChange={(event) => { setPage(1); setSort(event.target.value); }}>
            <option value="name_asc">Cliente: A–Z</option><option value="name_desc">Cliente: Z–A</option><option value="updated_desc">Última alteração</option>
          </select></label>
        </div>
        {error && <><p className="registry-error" role="alert">{error}</p><button className="button-secondary" onClick={() => setVersion((current) => current + 1)}>Tentar novamente</button></>}
        {!listing && !error && <div className="schedules-loading" role="status"><Icon name="repeat" /> Carregando recorrências…</div>}
        {listing && (listing.items.length ? (
          <ul className="schedule-cards" aria-label="Recorrências da empresa">{listing.items.map((item) => (
            <li key={item.id} className="schedule-card">
              <div className="schedule-card-top"><div className="schedule-client"><span className="schedule-avatar" aria-hidden="true">{item.customer.name.trim().slice(0, 2).toUpperCase()}</span><div><h3>{item.customer.name}</h3><span className="schedule-kind">{invoiceKindLabels[item.kind]}</span></div></div>
                <span className={"schedule-badge " + (!item.nextRunAt ? "is-paused" : item.automaticProduction ? "is-automatic" : "is-draft")}>
                  <span aria-hidden="true" />{!item.nextRunAt ? "Pausada" : item.automaticProduction ? "Automática ativa" : "Rascunho agendado"}
                </span>
              </div>
              <div className="schedule-card-body"><div className="schedule-amount"><span>Valor por mês</span><strong>{currency.format(Number(item.amount))}</strong></div>
                <dl className="schedule-meta"><div><dt>Frequência</dt><dd><Icon name="repeat" />Todo dia {String(item.dayOfMonth).padStart(2, "0")}</dd></div><div><dt>Próxima execução</dt><dd>{item.nextRunAt ? timestampLabel(item.nextRunAt) : "Aguardando ativação"}</dd></div><div><dt>Modo configurado</dt><dd>{item.automaticProduction ? "Emissão automática" : "Preparar rascunho"}</dd></div></dl>
              </div>
              {item.pauseReason && <p className="schedule-warning">{automaticMessages[item.pauseReason] ?? (item.pauseReason === "customer-unavailable" ? "Cliente indisponível. Confira o cadastro." : item.pauseReason === "service-unavailable" ? "Serviço indisponível. Confira o cadastro." : "Confira os dados antes de reativar.")}</p>}
              <div className="schedule-card-footer"><details><summary>Ver descrição e histórico</summary><p>{item.serviceDescription}</p><p>Última execução: {item.lastRunAt ? timestampLabel(item.lastRunAt) : "Nenhuma execução"}</p>
                {item.automaticRuns[0] && <p>{({ QUEUED: "Na fila", PROCESSING: "Em processamento", PENDING: "Aguardando confirmação da SEFIN", AUTHORIZED: "Nota autorizada", REJECTED: "Rejeitada · programação pausada", BLOCKED: "Bloqueada · programação pausada" } as Record<string, string>)[item.automaticRuns[0].status] ?? "Confira o resultado"}{item.automaticRuns[0].errorCode && " · " + (automaticMessages[item.automaticRuns[0].errorCode] ?? item.automaticRuns[0].errorCode)}</p>}
              </details><div className="record-actions"><button className="button-secondary" disabled={Boolean(editing || automatic)} onClick={() => { setEditing(item); setNotice(""); window.scrollTo(0, 0); }}>Configurar</button>
                {role === "OWNER" && <button className="button-secondary" disabled={Boolean(editing || automatic)} onClick={() => { setAutomatic(item.id); setNotice(""); window.scrollTo(0, 0); }}><Icon name="shield" />Emissão automática</button>}
              </div></div>
            </li>
          ))}</ul>
        ) : <div className="schedules-empty"><Icon name="repeat" /><h3>{query || status !== "all" || kind ? "Nenhuma programação encontrada" : "Organize sua primeira mensalidade"}</h3><p>{query || status !== "all" || kind ? "Ajuste os filtros ou procure outro cliente." : "Cadastre um cliente e configure o serviço, o valor e o dia da recorrência."}</p>
          {(query || search || status !== "all" || kind) && <button className="button-secondary" onClick={() => { setSearch(""); setQuery(""); setStatus("all"); setKind(""); setPage(1); }}>Limpar filtros</button>}
        </div>)}
        {listing && (page > 1 || listing.hasNext) && (
          <div className="record-actions registry-pagination">
            <button className="button-secondary" disabled={page === 1 || Boolean(editing || automatic)} onClick={() => setPage(page - 1)}>Anterior</button>
            <span>Página {page}</span>
            <button className="button-secondary" disabled={!listing.hasNext || page >= 10000 || Boolean(editing || automatic)} onClick={() => setPage(page + 1)}>Próxima</button>
          </div>
        )}
        <div className="schedules-note"><Icon name="shield" /><p>Conferir e configurar não emite notas. A emissão automática exige autorização do proprietário em cada programação. Você também pode criar uma recorrência a partir de um <a href="#rascunhos">rascunho salvo</a>.</p></div>
      </section>
    </div>
  );
}
