import { useEffect, useState } from "react";
import { dateLabel } from "../format";
import { useRegistrationRequest, type PageAccess } from "../registrations/api";

const dayMs = 86_400_000;
const warningDays = 30;

export function CertificateExpiry({ organizationId, endSession }: Pick<PageAccess, "organizationId" | "endSession">) {
  const request = useRegistrationRequest(organizationId, endSession);
  const [expiry, setExpiry] = useState<string>();
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const controller = new AbortController();
    request<{ certificate: { validUntil: string } | null }>("certificates", { signal: controller.signal })
      .then(({ certificate }) => { if (!controller.signal.aborted) setExpiry(certificate?.validUntil); })
      .catch(() => {});
    const refreshClock = () => setNow(Date.now());
    const clock = window.setInterval(refreshClock, 60_000);
    window.addEventListener("focus", refreshClock);
    return () => {
      controller.abort();
      window.clearInterval(clock);
      window.removeEventListener("focus", refreshClock);
    };
  }, [request]);

  if (!expiry) return null;
  const remaining = Date.parse(expiry) - now;
  if (!Number.isFinite(remaining) || remaining > warningDays * dayMs) return null;
  const days = Math.ceil(remaining / dayMs);
  const message = remaining <= 0 ? "O certificado A1 venceu"
    : days === 1 ? "O certificado A1 vence em menos de 24 horas" : `O certificado A1 vence em ${days} dias`;
  return <aside className="certificate-expiry" role="status">
    <div><strong>{message}.</strong> Validade até {dateLabel(expiry)}.</div>
    <a href="#certificados">Abrir certificados</a>
  </aside>;
}
