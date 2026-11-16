import type { Prisma } from "@prisma/client";

export type ProductionApproval = { dpsId: string; sha256: string };

export function certificateIsCurrent(certificate: { validFrom: Date; validUntil: Date } | null | undefined, now = Date.now()) {
  return Boolean(certificate && certificate.validFrom.getTime() <= now && now < certificate.validUntil.getTime());
}

export function productionAccess(
  organization: { cnpj: string | null; productionIssuanceEnabled: boolean | null },
  legacyCnpjs?: ReadonlySet<string>,
) {
  if (!organization.cnpj || organization.productionIssuanceEnabled === false) return;
  if (organization.productionIssuanceEnabled) return "company";
  if (legacyCnpjs?.has(organization.cnpj.replace(/[./-]/g, "").toUpperCase())) return "single-dps";
}

export async function readProductionAccess(db: Prisma.TransactionClient, organizationId: string, legacyCnpjs?: ReadonlySet<string>) {
  const organization = await db.organization.findUnique({
    where: { id: organizationId, archivedAt: null, accessSuspendedAt: null },
    select: { cnpj: true, productionIssuanceEnabled: true },
  });
  return organization ? productionAccess(organization, legacyCnpjs) : undefined;
}

type Access = ReturnType<typeof productionAccess>;

export function approvalForDps(access: Access, dpsId: string, sha256: string, legacyApproval?: ProductionApproval) {
  if (access === "company") return { dpsId, sha256 };
  if (access === "single-dps" && legacyApproval?.dpsId === dpsId && legacyApproval.sha256 === sha256) return legacyApproval;
}
