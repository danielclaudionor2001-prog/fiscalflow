import { DateInput } from "../formatted-inputs";
import { useState } from "react";
import { CatalogPicker, type CatalogOption } from "../invoices/catalog-picker";
import { useRegistrationRequest, type PageAccess } from "../registrations/api";
import { brl, dateLabel, Editor, field, jsonRequest, localToday, MoneyField, Notice, Pager, useAction, useResource, useSubmissionKey, type Listing, type Request } from "./shared";

type CashKind = "RECEIVABLE" | "PAYABLE" | "COMMISSION";
type Method = "PIX" | "CASH" | "CARD" | "BOLETO" | "TRANSFER" | "OTHER";
type Entry = { id: string; kind: CashKind; description: string; amount: string; balance: string; dueOn: string; cancelledAt: string | null; orderId: string | null; supplier: { name: string } | null };
type Payment = { id: string; amount: string; paidOn: string; method: Method; reversedAt: string | null };
type Daily = { day: string; kind: CashKind; total: string };
type Summary = { count: number; revenue: string; cost: string; margin: string; received: string; paid: string; cashResult: string; receivable: string; payable: string; payments: Daily[] };

const types: Record<CashKind, string> = { RECEIVABLE: "A receber", PAYABLE: "A pagar", COMMISSION: "Comissão" };
const methods: Record<Method, string> = { PIX: "Pix", CASH: "Dinheiro", CARD: "Cartão", BOLETO: "Boleto", TRANSFER: "Transferência", OTHER: "Outro" };

function entryStatus(entry: Entry) {
  if (entry.cancelledAt) return "Cancelada";
  if (Number(entry.balance) === 0) return "Quitada";
  return entry.dueOn.slice(0, 10) < localToday() ? "Vencida" : "Em aberto";
}

function FinanceEditor({ request, close, saved }: { request: Request; close: () => void; saved: () => void }) {
  const action = useAction();
  const submissionKey = useSubmissionKey();
  const [kind, setKind] = useState<"RECEIVABLE" | "PAYABLE">("PAYABLE");
  const [supplier, setSupplier] = useState<CatalogOption>();
  return <Editor title="Nova conta" action={action} onClose={close} onSubmit={async (form) => {
    const payload = {
      kind, description: field(form, "description"), amount: field(form, "amount"),
      dueOn: field(form, "dueOn"), supplierId: kind === "PAYABLE" ? supplier?.id ?? null : null,
    };
    await request("commercial/finance/entries", jsonRequest("POST", payload, { "Idempotency-Key": submissionKey(payload) }));
    saved();
  }}>
    <label>Tipo<select value={kind} onChange={(event) => setKind(event.target.value === "PAYABLE" ? "PAYABLE" : "RECEIVABLE")}>
      <option value="PAYABLE">A pagar</option><option value="RECEIVABLE">A receber</option>
    </select></label>
    <label>Descrição<input name="description" required maxLength={160} /></label>
    <MoneyField name="amount" label="Valor da conta" />
    <DateInput label="Vencimento" name="dueOn" required defaultValue={localToday()} />
    {kind === "PAYABLE" && <CatalogPicker request={request} resource="commercial/suppliers" label="Fornecedor"
      value={supplier?.id ?? ""} onChange={setSupplier} />}
  </Editor>;
}

function EntryDetail({ request, id, manage }: { request: Request; id: string; manage: boolean }) {
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState<Payment>();
  const action = useAction();
  const submissionKey = useSubmissionKey();
  const route = "commercial/finance/entries/" + encodeURIComponent(id);
  const detail = useResource<Listing<Payment> & { entry: Entry }>(request, route + "/payments?page=" + page);
  const organization = useResource<{ legalName: string; tradeName: string | null }>(request, "organizations/current");
  const entry = detail.data?.entry;
  if (!entry) return <Notice error={detail.error} pending reload={detail.reload} />;

  if (receipt) return <div className="commercial-stack">
    <div className="commercial-toolbar">
      <button className="secondary" onClick={() => setReceipt(undefined)}>Voltar para a conta</button>
      <button className="secondary" onClick={() => window.print()}>Imprimir / salvar PDF</button>
    </div>
    <section className="panel commercial-panel commercial-print">
      <p>{organization.data?.tradeName ?? organization.data?.legalName ?? "Fiscal Floow"}</p>
      <h2>{entry.kind === "RECEIVABLE" ? "Recibo de recebimento" : "Comprovante de pagamento"}</h2>
      <p>{entry.description}</p>
      <p>{dateLabel(receipt.paidOn)} · {methods[receipt.method]}</p>
      <p className="commercial-total">Valor registrado <strong>{brl(receipt.amount)}</strong></p>
      <small>Registro {receipt.id.slice(-8).toUpperCase()} · Controle interno · Sem valor fiscal</small>
    </section>
  </div>;

  if (editing) return <Editor title="Registrar baixa" action={action} onClose={() => setEditing(false)} onSubmit={async (form) => {
    const payload = { amount: field(form, "amount"), paidOn: field(form, "paidOn"), method: field(form, "method") };
    await request(route + "/payments", jsonRequest("POST", payload, {
      "Idempotency-Key": submissionKey({ ...payload, balance: entry.balance }),
    }));
    setNotice("Baixa registrada.");
    setEditing(false);
    setPage(1);
    detail.reload();
  }}>
    <MoneyField name="amount" label={"Valor recebido ou pago (saldo " + brl(entry.balance) + ")"} value={entry.balance} />
    <DateInput label="Data da baixa" name="paidOn" required max={localToday()} defaultValue={localToday()} />
    <label>Forma de pagamento<select name="method" required>
      {Object.entries(methods).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
  </Editor>;

  return <div className="commercial-stack">
    <div><a href="#contas">← Voltar para contas</a></div>
    <Notice error={action.error} reload={detail.reload} />
    {notice && <p role="status" className="registry-notice">{notice}</p>}
    <section className="panel commercial-panel">
      <div className="commercial-toolbar"><h2>{entry.description}</h2><span className="commercial-badge">{entryStatus(entry)}</span></div>
      <dl className="commercial-facts">
        <div><dt>Valor da conta</dt><dd>{brl(entry.amount)}</dd></div>
        <div><dt>Saldo em aberto</dt><dd>{brl(entry.cancelledAt ? 0 : entry.balance)}</dd></div>
        <div><dt>Vencimento</dt><dd>{dateLabel(entry.dueOn)}</dd></div>
        {entry.supplier && <div><dt>Fornecedor</dt><dd>{entry.supplier.name}</dd></div>}
      </dl>
      <div className="commercial-actions">
        {!entry.cancelledAt && Number(entry.balance) > 0 && <button disabled={action.busy} onClick={() => setEditing(true)}>Registrar baixa</button>}
        {entry.orderId && <a href={"#vendas?id=" + encodeURIComponent(entry.orderId)}>Ver venda vinculada</a>}
        {manage && !entry.orderId && !entry.cancelledAt && entry.balance === entry.amount &&
          <button className="secondary" disabled={action.busy} onClick={() => {
            if (window.confirm("Cancelar esta conta?")) void action.run(async () => {
              await request(route + "/cancel", { method: "POST" });
              setNotice("Conta cancelada.");
              detail.reload();
            });
          }}>Cancelar conta</button>}
      </div>
    </section>
    <section className="panel commercial-panel">
      <h2>Histórico de baixas</h2>
      <Notice error={detail.error} reload={detail.reload} />
      {detail.data?.items.length === 0 && <p>Nenhuma baixa nesta página.</p>}
      <div className="commercial-list">{detail.data?.items.map((payment) => <article key={payment.id}>
        <div><strong>{brl(payment.amount)} · {methods[payment.method]}</strong>
          <p>{dateLabel(payment.paidOn)}{payment.reversedAt ? " · Estornada" : ""}</p></div>
        {!payment.reversedAt && <div className="commercial-actions">
          <button className="secondary" onClick={() => setReceipt(payment)}>Ver comprovante</button>
          {manage && <button className="secondary" disabled={action.busy} onClick={() => {
            if (window.confirm("Estornar esta baixa e devolver o valor ao saldo da conta?")) void action.run(async () => {
              await request(route + "/payments/" + payment.id + "/reverse", { method: "POST" });
              setNotice("Baixa estornada.");
              detail.reload();
            });
          }}>Estornar</button>}
        </div>}
      </article>)}</div>
      <Pager page={page} hasNext={detail.data?.hasNext} onChange={setPage} />
    </section>
  </div>;
}

export function AccountsPage({ role, organizationId, endSession, id }: PageAccess & { id: string | null }) {
  const request = useRegistrationRequest(organizationId, endSession);
  if (id) return <EntryDetail key={id} request={request} id={id} manage={role === "OWNER" || role === "ADMIN"} />;
  return <AccountsList request={request} />;
}

function AccountsList({ request }: { request: Request }) {
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState(false);
  const query = new URLSearchParams({ page: String(page) });
  if (kind) query.set("kind", kind);
  if (status) query.set("status", status);
  const listing = useResource<Listing<Entry>>(request, "commercial/finance/entries?" + query);
  return <div className="commercial-stack">
    <div className="commercial-toolbar">
      <div className="commercial-actions">
        <label className="commercial-filter">Tipo<select value={kind} onChange={(event) => { setKind(event.target.value); setPage(1); }}>
          <option value="">Todos</option>{Object.entries(types).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select></label>
        <label className="commercial-filter">Situação<select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
          <option value="">Todas</option><option value="OPEN">Em aberto (todas)</option><option value="OVERDUE">Vencidas</option>
          <option value="SETTLED">Quitadas</option><option value="CANCELLED">Canceladas</option>
        </select></label>
      </div>
      {!editing && <button onClick={() => setEditing(true)}>Nova conta</button>}
    </div>
    {editing && <FinanceEditor request={request} close={() => setEditing(false)} saved={() => { setEditing(false); listing.reload(); }} />}
    <Notice error={listing.error} pending={!listing.data} reload={listing.reload} />
    {listing.data && <section className="panel commercial-panel">
      {listing.data.items.length === 0 && <p>Nenhuma conta nesta página.</p>}
      <div className="commercial-list">{listing.data.items.map((entry) => <article key={entry.id}>
        <div><strong>{entry.description}</strong>
          <p>{types[entry.kind]} · {dateLabel(entry.dueOn)} · {brl(entry.amount)}{!entry.cancelledAt ? " · saldo " + brl(entry.balance) : ""}</p>
          <span className={"commercial-badge" + (entryStatus(entry) === "Vencida" ? " attention" : "")}>{entryStatus(entry)}</span>
        </div>
        <a className="button secondary" href={"#contas?id=" + encodeURIComponent(entry.id)}>Ver detalhes</a>
      </article>)}</div>
      <Pager page={page} hasNext={listing.data.hasNext} onChange={setPage} />
    </section>}
  </div>;
}

function summarizeDays(payments: Daily[]) {
  const days = new Map<string, { incoming: number; outgoing: number }>();
  for (const payment of payments) {
    const total = days.get(payment.day) ?? { incoming: 0, outgoing: 0 };
    if (payment.kind === "RECEIVABLE") total.incoming += Number(payment.total);
    else total.outgoing += Number(payment.total);
    days.set(payment.day, total);
  }
  return [...days.entries()];
}

function downloadCash(days: ReturnType<typeof summarizeDays>, from: string, to: string) {
  const rows = ["Data;Entradas;Saídas", ...days.map(([day, totals]) =>
    [dateLabel(day), totals.incoming.toFixed(2).replace(".", ","), totals.outgoing.toFixed(2).replace(".", ",")].join(";"))];
  const url = URL.createObjectURL(new Blob(["\ufeff" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "fiscalflow-caixa-" + from + "-" + to + ".csv";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function ManagementPage({ organizationId, endSession }: PageAccess) {
  const request = useRegistrationRequest(organizationId, endSession);
  const [period, setPeriod] = useState(() => ({ from: localToday().slice(0, 8) + "01", to: localToday() }));
  const summary = useResource<Summary>(request, "commercial/finance/summary?" + new URLSearchParams(period));
  const report = summary.data;
  const days = summarizeDays(report?.payments ?? []);
  const max = Math.max(1, ...days.flatMap(([, values]) => [values.incoming, values.outgoing]));
  return <div className="commercial-stack">
    <form className="commercial-actions commercial-period" onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      setPeriod({ from: field(form, "from"), to: field(form, "to") });
    }}>
      <DateInput className="commercial-filter" label="De" name="from" required defaultValue={period.from} />
      <DateInput className="commercial-filter" label="Até" name="to" required defaultValue={period.to} />
      <button type="submit">Aplicar período</button>
      <a className="button secondary" href="#contas">Abrir contas</a>
    </form>
    <Notice error={summary.error} pending={!report} reload={summary.reload} />
    {report && <>
      <section className="commercial-metrics" aria-label="Indicadores da gestão">
        <div><span>Vendas confirmadas</span><strong>{brl(report.revenue)}</strong><small>{report.count} venda(s) no período</small></div>
        <div><span>Custo dos produtos vendidos</span><strong>{brl(report.cost)}</strong><small>Com base no custo do cadastro</small></div>
        <div><span>Margem antes de despesas</span><strong>{brl(report.margin)}</strong><small>Vendas menos custo de produtos</small></div>
        <div><span>Recebido no período</span><strong>{brl(report.received)}</strong><small>A receber hoje: {brl(report.receivable)}</small></div>
        <div><span>Pago no período</span><strong>{brl(report.paid)}</strong><small>A pagar hoje: {brl(report.payable)}</small></div>
        <div><span>Saldo de caixa no período</span><strong>{brl(report.cashResult)}</strong><small>Entradas menos saídas registradas</small></div>
      </section>
      <section className="panel commercial-panel">
        <div className="commercial-toolbar"><h2>Movimentação diária de caixa</h2>
          <button className="secondary" onClick={() => downloadCash(days, period.from, period.to)} disabled={!days.length}>Baixar CSV</button>
        </div>
        {days.length ? <div className="registry-table compact-table">
          <table><thead><tr><th scope="col">Data</th><th scope="col">Entradas</th><th scope="col">Saídas</th></tr></thead>
            <tbody>{days.map(([day, values]) => <tr key={day}>
              <td data-label="Data">{dateLabel(day)}</td>
              <td data-label="Entradas"><span>{brl(values.incoming)}</span><meter aria-label={"Entradas em " + dateLabel(day)} min={0} max={max} value={values.incoming} /></td>
              <td data-label="Saídas"><span>{brl(values.outgoing)}</span><meter aria-label={"Saídas em " + dateLabel(day)} min={0} max={max} value={values.outgoing} /></td>
            </tr>)}</tbody>
          </table>
        </div> : <p>Nenhuma baixa registrada no período.</p>}
      </section>
    </>}
  </div>;
}
