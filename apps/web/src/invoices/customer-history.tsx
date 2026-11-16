import { dateLabel } from "../format";
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
  customer?: { name: string };
  items: Array<{
    id: string;
    customerId?: string;
    customerName?: string;
    status: keyof typeof statusLabels;
    serviceDescription: string;
    amount: string;
    date: string;
    dpsId?: string | null;
    accessKey: string | null;
    hasXml?: boolean;
  }>;
  hasNext: boolean;
};

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

const customerInvoicesPath = (id: string) => "customers/" + encodeURIComponent(id) + "/invoices";

export function InvoiceHistoryPage({ customerId, organizationId, role, endSession }: PageAccess & { customerId?: string }) {
  const canViewBilling = customerId && (role === "OWNER" || role === "ADMIN" || role === "ACCOUNTANT");
  const request = useRegistrationResponse(organizationId, endSession);
  const path = customerId ? customerInvoicesPath(customerId) : "invoices/issued";
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [history, setHistory] = useState<History>();
  const title = customerId ? (history?.customer ? "Notas de " + history.customer.name : "Notas do cliente") : "Notas emitidas";
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

  async function downloadDocument(key: string, documentPath: string, filename: string) {
    if (download.current) return;
    const controller = new AbortController();
    download.current = controller;
    setDownloading(key);
    setDownloadError("");
    try {
      const response = await request(documentPath, { signal: controller.signal });
      const file = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (!controller.signal.aborted) {
        const code = failure instanceof RegistrationError ? failure.code : undefined;
        const messages: Record<string, string> = {
          "dps-pdf-unavailable": "Essa DPS não está mais disponível para baixar.",
          "nfse-xml-unavailable": "O XML desta nota não está disponível.",
          "danfse-unavailable": "O PDF desta nota está disponível no Portal Nacional.",
          "danfse-layout-unavailable": "Baixe o DANFSe desta nota pelo Portal Nacional.",
        };
        setDownloadError((code && messages[code]) || errorMessage(failure));
      }
    } finally {
      download.current = null;
      if (!controller.signal.aborted) setDownloading(undefined);
    }
  }

  return (
    <div className="registry-card">
      <div className="registry-heading">
        <h2>{title}</h2>
        {customerId && <a href="#clientes">Voltar aos clientes</a>}
      </div>
      {error && <p className="registry-error" role="alert">{error}</p>}
      {downloadError && <p className="registry-error" role="alert">{downloadError}</p>}
      {(error || downloadError) && <button className="button-secondary" onClick={() => {
        setDownloadError("");
        setRetry((current) => current + 1);
      }}>Atualizar lista</button>}
      {!history && !error && <p role="status">Carregando notas…</p>}
      {history && history.items.length === 0 && <p>{customerId ? "Nenhuma nota nesta página." : "Nenhuma nota emitida nesta página."}</p>}
      {history && history.items.length > 0 && (
        <div className="registry-table compact-table">
          <table role="table" aria-label={customerId ? "Notas do cliente" : "Notas emitidas"}>
            <thead><tr><th scope="col">Data</th>{!customerId && <th scope="col">Cliente</th>}
              <th scope="col">Descrição</th><th scope="col">Valor</th><th scope="col">Situação</th><th scope="col">Documento</th></tr></thead>
            <tbody role="rowgroup">
              {history.items.map((item) => {
                const ownerCustomerId = customerId ?? item.customerId;
                const documentPath = ownerCustomerId ? customerInvoicesPath(ownerCustomerId) : undefined;
                const invoicePath = documentPath && documentPath + "/" + encodeURIComponent(item.id);
                const { dpsId, accessKey } = item;
                return (
                <tr role="row" key={item.id}>
                  <td role="cell" data-label="Data">{dateLabel(item.date)}</td>
                  {!customerId && <td role="cell" data-label="Cliente">{item.customerName}</td>}
                  <td role="cell" data-label="Descrição">{item.serviceDescription}</td>
                  <td role="cell" data-label="Valor">{currency.format(Number(item.amount))}</td>
                  <td role="cell" data-label="Situação">{item.dpsId ? "DPS de teste assinada" : statusLabels[item.status]}</td>
                  <td role="cell" className="cell-wide" data-label="Documento">
                    {documentPath && dpsId && <button type="button" className="button-secondary" disabled={Boolean(downloading)} onClick={() =>
                      void downloadDocument(dpsId, documentPath + "/dps/" + encodeURIComponent(dpsId) + ".pdf", "dps-teste-" + dpsId + ".pdf")}>
                      {downloading === dpsId ? "Preparando PDF…" : "Baixar PDF de teste"}
                    </button>}
                    {accessKey && (
                      <>
                        {customerId && <code className="invoice-access-key">{accessKey}</code>}
                        <div className="record-actions">
                          {invoicePath && item.hasXml && <button type="button" className="button-secondary" disabled={Boolean(downloading)} onClick={() =>
                            void downloadDocument(item.id + "-pdf", invoicePath + "/nfse.pdf", "danfse-" + accessKey + ".pdf")}>
                            {downloading === item.id + "-pdf" ? "Preparando PDF…" : "Baixar PDF da NFS-e"}
                          </button>}
                          {customerId && invoicePath && item.hasXml && <button type="button" className="button-secondary" disabled={Boolean(downloading)} onClick={() =>
                            void downloadDocument(item.id + "-xml", invoicePath + "/nfse.xml", "nfse-" + accessKey + ".xml")}>
                            {downloading === item.id + "-xml" ? "Preparando XML…" : "Baixar XML da NFS-e"}
                          </button>}
                          <a href={"https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=" + encodeURIComponent(accessKey)}
                            target="_blank" rel="noreferrer">Consultar no Portal Nacional</a>
                        </div>
                      </>
                    )}
                    {canViewBilling && (item.status === "DRAFT" || item.status === "AUTHORIZED") &&
                      <a href={"#boletos?nota=" + encodeURIComponent(item.id)}>Ver cobrança</a>}
                    {!item.dpsId && !item.accessKey && !(canViewBilling && (item.status === "DRAFT" || item.status === "AUTHORIZED")) && "—"}
                  </td>
                </tr>
                );
              })}
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
