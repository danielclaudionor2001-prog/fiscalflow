const dayMs = 86_400_000;
export type CertificateValidity = { kind: "valid" | "expiring" | "urgent" | "expired" | "upcoming"; days: number; needsAttention: boolean };

export function certificateValidity(validUntil: string, now = Date.now(), validFrom?: string): CertificateValidity | null {
  const end = Date.parse(validUntil);
  if (!Number.isFinite(end) || !Number.isFinite(now)) return null;
  const remaining = end - now;
  if (remaining <= 0) return { kind: "expired", days: 0, needsAttention: true };
  const days = Math.ceil(remaining / dayMs);
  if (validFrom && Date.parse(validFrom) > now) return { kind: "upcoming", days, needsAttention: true };
  return { kind: remaining <= 7 * dayMs ? "urgent" : remaining <= 30 * dayMs ? "expiring" : "valid", days, needsAttention: remaining <= 30 * dayMs };
}

export function certificateExpiryMessage(validity: CertificateValidity) {
  if (validity.kind === "expired") return "O certificado A1 está vencido";
  if (validity.kind === "upcoming") return "A validade do certificado A1 ainda não começou";
  return validity.days === 1 ? "O certificado A1 vence em até 24 horas" : `O certificado A1 vence em ${validity.days} dias`;
}
