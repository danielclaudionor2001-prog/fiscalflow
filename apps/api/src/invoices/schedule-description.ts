const months = ["JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"];
const monthReference = /\b(DO M[ÊE]S DE )(JANEIRO|FEVEREIRO|MARÇO|ABRIL|MAIO|JUNHO|JULHO|AGOSTO|SETEMBRO|OUTUBRO|NOVEMBRO|DEZEMBRO)(?=\s*[,.;]|\s*$)/giu;

export const maintenanceDescription = "PRESTAÇÃO DE SERVIÇOS E DE MANUTENÇÃO PREVENTIVA E CORRETIVA DO MÊS DE NOVEMBRO, CONFORME CONTRATO DE MANUTENÇÃO MENSAL DOS ELEVADORES.";

export const issuancePeriod = (date: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(date).slice(0, 7);

export function hasMonthlyReference(description: string) {
  return [...description.matchAll(monthReference)].length === 1;
}

export function scheduleDescription(schedule: { serviceDescription: string; previousMonthDescription: boolean }, period: string) {
  if (!schedule.previousMonthDescription) return schedule.serviceDescription;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || !hasMonthlyReference(schedule.serviceDescription)) {
    throw new Error("monthly-description-invalid");
  }
  const previousMonth = months[(Number(period.slice(5)) + 10) % 12];
  return schedule.serviceDescription.replace(monthReference, (_match, prefix: string) => prefix + previousMonth);
}
