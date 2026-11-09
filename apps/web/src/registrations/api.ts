import { useCallback } from "react";
import type { Role } from "../auth";

export type PageAccess = { role: Role; organizationId: string; endSession: () => void };
export type RecordData = Record<string, string | boolean | null>;

export class RegistrationError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, code?: string) {
    super(`Cadastro HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

export function useRegistrationResponse(organizationId: string, endSession: () => void) {
  return useCallback(async (path: string, options?: RequestInit) => {
    const headers = new Headers(options?.headers);
    headers.set("X-FiscalFlow-Context", organizationId);
    const response = await fetch(`/api/${path}`, { credentials: "same-origin", ...options, headers });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      const code = typeof body?.code === "string" ? body.code : undefined;
      if (response.status === 401 || (response.status === 409 && code === "organization-changed")) endSession();
      throw new RegistrationError(response.status, code);
    }
    return response;
  }, [organizationId, endSession]);
}

export function useRegistrationRequest(organizationId: string, endSession: () => void) {
  const request = useRegistrationResponse(organizationId, endSession);
  return useCallback(async <T>(path: string, options?: RequestInit): Promise<T> => {
    const response = await request(path, options);
    if (response.status === 204) return undefined as T;
    return response.json();
  }, [request]);
}

export function jsonMutation(method: "POST" | "PATCH" | "PUT", data: Record<string, string | number | boolean | null>): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
}

export function errorMessage(error: unknown) {
  if (error instanceof RegistrationError) {
    switch (error.status) {
      case 400: return "Revise os dados informados. Confira o formato dos documentos e valores.";
      case 403: return "Seu papel não permite essa operação.";
      case 404: return "O cadastro não está disponível nesta empresa.";
      case 409: return "Já existe um cadastro com esse documento.";
      case 429: return "Muitas solicitações. Aguarde um momento e tente novamente.";
    }
  }
  return "Não foi possível concluir a operação. Tente novamente.";
}
