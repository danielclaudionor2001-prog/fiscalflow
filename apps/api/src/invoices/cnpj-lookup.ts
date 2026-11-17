import { z } from "zod";
import { cnpjSchema, customerCreate } from "../registrations/input.ts";

const directoryEntry = z.object({ cnpj: cnpjSchema, razao_social: customerCreate.shape.name });
type DirectoryResult = { source: "public"; name: string } | { source: "not-found" | "unavailable" };
export type PublicCnpjLookup = (cnpj: string) => Promise<DirectoryResult>;

export function hasCnpjCheckDigits(cnpj: string) {
  if (!/^[A-Z0-9]{12}\d{2}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
  return [12, 13].every((length) => {
    let sum = 0;
    for (let index = 0; index < length; index++) {
      const weight = (length - index - 1) % 8 + 2;
      sum += (cnpj.charCodeAt(index) - 48) * weight;
    }
    const rest = sum % 11;
    return Number(cnpj[length]) === (rest < 2 ? 0 : 11 - rest);
  });
}

export async function lookupPublicCnpj(cnpj: string, fetchDirectory = fetch): Promise<DirectoryResult> {
  try {
    const response = await fetchDirectory("https://brasilapi.com.br/api/cnpj/v1/" + encodeURIComponent(cnpj), {
      headers: { Accept: "application/json", "User-Agent": "FiscalFloow/0.1 (https://fiscalfloow.com.br)" },
      redirect: "error", signal: AbortSignal.timeout(5500),
    });
    if (response.status === 404) return { source: "not-found" };
    if (!response.ok) return { source: "unavailable" };
    const entry = directoryEntry.safeParse(await response.json());
    if (!entry.success || entry.data.cnpj !== cnpj) return { source: "unavailable" };
    return { source: "public", name: entry.data.razao_social };
  } catch {
    return { source: "unavailable" };
  }
}
