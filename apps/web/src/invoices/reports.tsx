import { useEffect, useRef, useState, type FormEvent } from "react";
import { errorMessage, RegistrationError, useRegistrationResponse, type PageAccess } from "../registrations/api";

type Period = { from: string; to: string };
type Report = {
  count: number;
  amount: string;
  hasNext: boolean;
  items: Array<{
    id: string;
    createdAt: string;
    amount: string;
    serviceDescription: string;
    customer: { name: string };
    service: { name: string } | null;
  }>;
};

const brasiliaDate = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short" });

function currentPeriod(): Period {
  const today = Date.now() - 3 * 3_600_000;
  return {
    from: new Date(today - 29 * 86_400_000).toISOString().slice(0, 10),
    to: new Date(today).toISOString().slice(0, 10),
  };
}

function formatAmount(amount: string) {
  const [whole, cents] = amount.split(".");
  return "R$ " + BigInt(whole).toLocaleString("pt-BR") + "," + cents;
}

function reportError(error: unknown) {
  if (error instanceof RegistrationError) {
    if (error.code === "invalid-report-period") return "Informe um período de até 366 dias.";
    if (error.code === "report-too-large") return "O arquivo ultrapassa 5.000 rascunhos. Selecione um período menor.";
  }
  return errorMessage(error);
}

export function InvoiceReportsPage({ organizationId, endSession }: PageAccess) {
  const request = useRegistrationResponse(organizationId, endSession);
  const [period, setPeriod] = useState(currentPeriod);
  const [form, setForm] = useState(period);
  const [page, setPage] = useState(1);
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const download = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ ...period, page: String(page) });
    setReport(undefined);
    setError("");
    request("reports/drafts?" + query, { signal: controller.signal })
      .then((response) => response.json() as Promise<Report>)
      .then((data) => { if (!controller.signal.aborted) setReport(data); })
      .catch((failure) => { if (!controller.signal.aborted) setError(reportError(failure)); });
    return () => controller.abort();
  }, [request, period, page]);

  useEffect(() => () => download.current?.abort(), []);

  function applyPeriod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setPeriod({ ...form });
  }

  async function exportReport() {
    if (download.current) return;
    const controller = new AbortController();
    download.current = controller;
    setDownloading(true);
    setError("");
    try {
      const response = await request("reports/drafts.csv?" + new URLSearchParams(period), { signal: controller.signal });
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "rascunhos.csv";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (!controller.signal.aborted) setError(reportError(failure));
    } finally {
      download.current = null;
      if (!controller.signal.aborted) setDownloading(false);
    }
  }

  return (
    <div className="registry">
      <form className="record-form registry-card" onSubmit={applyPeriod}>
        <h2>Rascunhos por período</h2>
        <p>Considere a data de criação no horário de Brasília.</p>
        <label>Data inicial
          <input type="date" required min="2020-01-01" max={form.to || undefined} value={form.from}
            onChange={(event) => setForm({ ...form, from: event.target.value })} />
        </label>
        <label>Data final
          <input type="date" required min={form.from || "2020-01-01"} value={form.to}
            onChange={(event) => setForm({ ...form, to: event.target.value })} />
        </label>
        <div className="record-actions">
          <button disabled={downloading}>Aplicar período</button>
          <button type="button" className="button-secondary" disabled={!report?.count || downloading} onClick={() => void exportReport()}>
            {downloading ? "Preparando CSV…" : "Exportar CSV"}
          </button>
        </div>
      </form>
      {error && <p className="registry-error" role="alert">{error}</p>}
      {!report && !error && <p role="status">Carregando relatório…</p>}
      {report && (
        <div className="registry-card">
          <div className="registry-heading">
            <h2>Totais do período</h2>
            <p><strong>{report.count.toLocaleString("pt-BR")}</strong> rascunhos · <strong>{formatAmount(report.amount)}</strong></p>
          </div>
          {report.items.length ? (
            <div className="registry-table">
              <table aria-label="Rascunhos no período">
                <thead><tr><th scope="col">Criação</th><th scope="col">Cliente</th><th scope="col">Serviço</th><th scope="col">Descrição</th><th scope="col">Valor</th></tr></thead>
                <tbody>{report.items.map((item) => (
                  <tr key={item.id}>
                    <td>{brasiliaDate.format(new Date(item.createdAt))}</td><td>{item.customer.name}</td>
                    <td>{item.service?.name ?? "—"}</td><td>{item.serviceDescription}</td><td>{formatAmount(item.amount)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p>Nenhum rascunho neste período.</p>}
          {(page > 1 || report.hasNext) && (
            <div className="record-actions registry-pagination">
              <button className="button-secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Anterior</button>
              <span>Página {page}</span>
              <button className="button-secondary" disabled={!report.hasNext || page >= 10000} onClick={() => setPage(page + 1)}>Próxima</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
