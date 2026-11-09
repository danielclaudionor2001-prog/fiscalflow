import { useEffect, useState } from "react";
import { errorMessage, useRegistrationRequest, type PageAccess } from "../registrations/api";
import { Icon } from "../ui";
import "./issuance-summary.css";

type IssuanceSummary = {
  month: string;
  issuedCount: number;
  totalAmount: string;
  days: { day: number; count: number }[];
};

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const integer = new Intl.NumberFormat("pt-BR");
const monthLabel = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", month: "long", year: "numeric" });
const brasiliaMonth = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" });

function formatAmount(amount: string) {
  const [whole, cents] = amount.split(".");
  return brl.formatToParts(whole === "-0" ? -0 : BigInt(whole))
    .map(({ type, value }) => type === "fraction" ? cents : value).join("");
}

function monthOptions() {
  const today = new Date(brasiliaMonth.format(new Date()) + "-01T00:00:00Z");
  return Array.from({ length: 12 }, (_, offset) => {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - offset, 1));
    return { value: date.toISOString().slice(0, 7), label: monthLabel.format(date) };
  });
}

function IssuanceChart({ summary }: { summary: IssuanceSummary }) {
  const [year, month] = summary.month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const counts = new Map(summary.days.map(({ day, count }) => [day, count]));
  const max = Math.max(1, ...counts.values());
  const empty = summary.issuedCount === 0;
  return (
    <section className="issuance-chart" aria-labelledby="issuance-chart-title">
      <div className="issuance-chart-heading">
        <h3 id="issuance-chart-title">Emissões por dia</h3>
        <span><i aria-hidden="true" /> NFS-e autorizadas</span>
      </div>
      <div className="issuance-plot">
        {empty ? <p>Nenhuma NFS-e autorizada neste mês.</p>
          : <div className="issuance-bars" role="img" aria-label={summary.days.map(({ day, count }) => `Dia ${day}, ${count} NFS-e`).join(". ")}>
            {Array.from({ length: lastDay }, (_, index) => {
              const day = index + 1;
              const count = counts.get(day) ?? 0;
              return <div className="issuance-bar-slot" key={day} aria-hidden="true" title={`Dia ${day} · ${count} NFS-e`}>
                {count > 0 && <span style={{ height: (count / max) * 100 + "%" }} />}
              </div>;
            })}
          </div>}
      </div>
      <div className="issuance-axis" aria-hidden="true"><span>01</span><span>08</span><span>15</span><span>22</span><span>{lastDay}</span></div>
    </section>
  );
}

export function IssuancePanel({ organizationId, endSession }: Pick<PageAccess, "organizationId" | "endSession">) {
  const request = useRegistrationRequest(organizationId, endSession);
  const [options] = useState(monthOptions);
  const [month, setMonth] = useState(options[0].value);
  const [summary, setSummary] = useState<IssuanceSummary>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setSummary(undefined);
    setError("");
    request<IssuanceSummary>("dashboard/issuance?month=" + month, { signal: abort.signal })
      .then((result) => { if (!abort.signal.aborted) setSummary(result); })
      .catch((failure) => { if (!abort.signal.aborted) setError(errorMessage(failure)); });
    return () => abort.abort();
  }, [month, request, retry]);

  return (
    <section className="issuance-panel" aria-labelledby="issuance-title">
      <div className="issuance-heading">
        <div>
          <span className="issuance-eyebrow">RESUMO FISCAL</span>
          <h2 id="issuance-title">Emissões do mês</h2>
          <p>Acompanhe as NFS-e autorizadas na sua conta.</p>
        </div>
        <label className="issuance-month"><span>Mês de emissão</span>
          <select value={month} onChange={(event) => setMonth(event.currentTarget.value)}>
            {options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      {error && <div className="issuance-message">
        <p role="alert">{error}</p>
        <button type="button" className="button-secondary" onClick={() => setRetry((attempt) => attempt + 1)}>Tentar novamente</button>
      </div>}
      {!summary && !error && <p className="issuance-message" role="status">Carregando o resumo de emissões…</p>}
      {summary && <div className="issuance-grid">
        <div className="issuance-metrics">
          <article className="issuance-metric issuance-metric-count">
            <span className="issuance-icon"><Icon name="document" /></span>
            <div><h3>Notas emitidas</h3><strong>{integer.format(summary.issuedCount)}</strong></div>
          </article>
          <article className="issuance-metric issuance-metric-value">
            <span className="issuance-icon"><Icon name="report" /></span>
            <div><h3>Valor total emitido</h3><strong>{formatAmount(summary.totalAmount)}</strong></div>
          </article>
        </div>
        <IssuanceChart summary={summary} />
      </div>}
    </section>
  );
}
