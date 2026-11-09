export const invoiceKindLabels = {
  AVULSA: "Avulsa",
  MENSALIDADE: "Mensalidade",
  MODERNIZACAO: "Modernização",
  ORCAMENTO: "Orçamento",
};

export type InvoiceKind = keyof typeof invoiceKindLabels;
export const monthlyKinds = ["MENSALIDADE", "MODERNIZACAO", "ORCAMENTO"] as const;
export type MonthlyKind = typeof monthlyKinds[number];
