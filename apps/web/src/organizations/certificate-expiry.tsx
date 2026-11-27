import { useEffect, useState } from "react";
import { timestampLabel } from "../format";
import { useRegistrationRequest, type PageAccess } from "../registrations/api";
import { Icon } from "../ui";
import { certificateExpiryMessage, certificateValidity } from "./certificate-status";
import "./certificates.css";

type CertificateDates = { validUntil: string; validFrom?: string };
const changeEvent = "fiscalflow:certificate-changed";

export function notifyCertificateChanged(organizationId: string) {
  window.dispatchEvent(new CustomEvent(changeEvent, { detail: organizationId }));
}

export function useCertificateClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 60_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, []);
  return now;
}

export function CertificateExpiryNotice({ certificate, now, showLink = true }: { certificate: CertificateDates; now: number; showLink?: boolean }) {
  const validity = certificateValidity(certificate.validUntil, now, certificate.validFrom);
  if (!validity?.needsAttention) return null;
  const urgent = validity.kind === "urgent" || validity.kind === "expired";
  return <aside className={"certificate-expiry certificate-alert " + (urgent ? "certificate-alert-danger" : "certificate-alert-warning")} role={urgent ? "alert" : "status"}>
    <span className="certificate-alert-icon"><Icon name="bell" /></span>
    <div className="certificate-alert-copy"><strong>{certificateExpiryMessage(validity)}.</strong>
      <span>Validade até {timestampLabel(certificate.validUntil)}. {validity.kind === "expired" ? "Substitua o A1 para voltar a emitir." : validity.kind === "upcoming" ? "Confira a data de início da validade." : "Providencie a renovação para manter suas emissões."}</span>
    </div>
    {showLink && <a className="button button-secondary" href="#certificados">Ver certificado<Icon name="arrow" /></a>}
  </aside>;
}

export function CertificateExpiry({ organizationId, endSession }: Pick<PageAccess, "organizationId" | "endSession">) {
  const request = useRegistrationRequest(organizationId, endSession);
  const [certificate, setCertificate] = useState<CertificateDates | null>();
  const [failed, setFailed] = useState(false);
  const now = useCertificateClock();
  useEffect(() => {
    let controller: AbortController | undefined;
    let disposed = false;
    let lastFetch = 0;
    function refresh(force = false) {
      if (disposed || (!force && (document.hidden || Date.now() - lastFetch < 30_000))) return;
      lastFetch = Date.now();
      controller?.abort();
      const current = controller = new AbortController();
      request<{ certificate: CertificateDates | null }>("certificates", { signal: current.signal })
        .then((result) => { if (!disposed && !current.signal.aborted) { setCertificate(result.certificate); setFailed(false); } })
        .catch(() => { if (!disposed && !current.signal.aborted) setFailed(true); });
    }
    const onFocus = () => refresh();
    const onChange = (event: Event) => { if ((event as CustomEvent<unknown>).detail === organizationId) refresh(true); };
    refresh(true);
    const timer = window.setInterval(onFocus, 5 * 60_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener(changeEvent, onChange);
    return () => { disposed = true; controller?.abort(); window.clearInterval(timer); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); window.removeEventListener(changeEvent, onChange); };
  }, [request, organizationId]);
  if (certificate) return <CertificateExpiryNotice certificate={certificate} now={now} />;
  return failed ? <aside className="certificate-expiry" role="status">Não foi possível conferir a validade do A1. <a href="#certificados">Conferir certificado</a></aside> : null;
}
