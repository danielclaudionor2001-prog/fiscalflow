import { useEffect, useRef, useState } from "react";
import { errorMessage, RegistrationError, useRegistrationResponse, type PageAccess } from "../registrations/api";

const statusLabels = {
  DRAFT: "Rascunho",
  QUEUED: "Na fila",
  PROCESSING: "Em processamento",
  AUTHORIZED: "NFS-e autorizada",
  REJECTED: "Rejeitada",
  CANCEL_REQUESTED: "Cancelamento solicitado",
  CANCELLED: "Cancelada",
  FAILED: "Falha",
};

type History = {
  customer: { name: string };
  items: Array<{
    id: string;
    status: keyof typeof statusLabels;
    serviceDescription: string;
    amount: string;
    date: string;
    dpsId: string | null;
    accessKey: string | null;
  }>;
  hasNext: boolean;
};

const date = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short" });
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function CustomerInvoicePage({ customerId, organizationId, role, endSession }: PageAccess & { customerId: string }) {
  const canViewBilling = role === "OWNER" || role === "ADMIN" || role === "ACCOUNTANT";
  const request = useRegistrationResponse(organizationId, endSession);
  const path = "customers/" + encodeURIComponent(customerId) + "/invoices";
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [history, setHistory] = useState<History>();
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState<string>();
  const [downloadError, setDownloadError] = useState("");
  const download = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setHistory(undefined);
    setError("");
    request(path + "?page=" + page, { signal: controller.signal })
      .then((response) => response.json() as Promise<History>)
      .then((data) => { if (!controller.signal.aborted) setHistory(data); })
      .catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [path, page, request, retry]);

  useEffect(() => () => download.current?.abort(), []);

  async function downloadPdf(dpsId: string) {
    if (download.current) return;
    const controller = new AbortController();
    download.current = controller;
    setDownloading(dpsId);
    setDownloadError("");
    try {
      const response = await request(path + "/dps/" + encodeURIComponent(dpsId) + ".pdf", { signal: controller.signal });
      const file = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = "dps-teste-" + dpsId + ".pdf";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setDownloadError(failure instanceof RegistrationError && failure.status === 404
          ? "Essa DPS não está mais disponível para baixar. Atualize a lista de notas."
          : errorMessage(failure));
      }
    } finally {
      download.current = null;
      if (!controller.signal.aborted) setDownloading(undefined);
    }
  }

  return (
    <div className="registry-card">
      <div className="registry-heading">
        <h2>{history ? "Notas de " + history.customer.name : "Notas do cliente"}</h2>
        <a href="#clientes">Voltar aos clientes</a>
      </div>
      {error && <p className="registry-error" role="alert">{error}</p>}
      {downloadError && <p className="registry-error" role="alert">{downloadError}</p>}
      {(error || downloadError) && <button className="button-secondary" onClick={() => {
        setDownloadError("");
        setRetry((current) => current + 1);
      }}>Atualizar lista</button>}
      {!history && !error && <p role="status">Carregando notas…</p>}
      {history && history.items.length === 0 && <p>Nenhuma nota nesta página.</p>}
      {history && history.items.length > 0 && (
        <div className="registry-table compact-table">
          <table role="table" aria-label="Notas do cliente">
            <thead><tr><th scope="col">Data</th><th scope="col">Descrição</th><th scope="col">Valor</th><th scope="col">Situação</th><th scope="col">Documento</th></tr></thead>
            <tbody role="rowgroup">
              {history.items.map((item) => (
                <tr role="row" key={item.id}>
                  <td role="cell" data-label="Data">{date.format(new Date(item.date))}</td>
                  <td role="cell" data-label="Descrição">{item.serviceDescription}</td>
                  <td role="cell" data-label="Valor">{currency.format(Number(item.amount))}</td>
                  <td role="cell" data-label="Situação">{item.dpsId ? "DPS de teste assinada" : statusLabels[item.status]}</td>
                  <td role="cell" className="cell-wide" data-label="Documento">
                    {item.dpsId && <button className="button-secondary" disabled={Boolean(downloading)} onClick={() => void downloadPdf(item.dpsId!)}>
                      {downloading === item.dpsId ? "Preparando PDF…" : "Baixar PDF de teste"}
                    </button>}
                    {item.accessKey && (
                      <>
                        <code className="invoice-access-key">{item.accessKey}</code>
                        <a href="https://www.nfse.gov.br/consultapublica" target="_blank" rel="noreferrer">Consultar PDF oficial no Portal Nacional</a>
                      </>
                    )}
                    {canViewBilling && (item.status === "DRAFT" || item.status === "AUTHORIZED") &&
                      <a href={"#boletos?nota=" + encodeURIComponent(item.id)}>Ver cobrança</a>}
                    {!item.dpsId && !item.accessKey && !(canViewBilling && (item.status === "DRAFT" || item.status === "AUTHORIZED")) && "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {history && (page > 1 || history.hasNext) && (
        <div className="record-actions registry-pagination">
          <button className="button-secondary" disabled={page === 1 || Boolean(downloading)} onClick={() => setPage(page - 1)}>Anterior</button>
          <span>Página {page}</span>
          <button className="button-secondary" disabled={!history.hasNext || page >= 10000 || Boolean(downloading)} onClick={() => setPage(page + 1)}>Próxima</button>
        </div>
      )}
    </div>
  );
}
