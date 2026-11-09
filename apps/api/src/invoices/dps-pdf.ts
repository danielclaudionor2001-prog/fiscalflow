import PDFDocument from "pdfkit";
import type { readLocalDpsSummary } from "../fiscal/documents.ts";

const dateTime = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short",
});
const number = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function dpsConferencePdf(data: ReturnType<typeof readLocalDpsSummary>, preparedAt: Date) {
  const doc = new PDFDocument({
    size: "A4", margins: { top: 66, right: 48, bottom: 52, left: 48 }, bufferPages: true,
    info: { Title: "DPS de teste - " + data.id, Creator: "FiscalFlow" },
  });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.once("end", () => resolve(Buffer.concat(chunks)));
    doc.once("error", reject);
  });
  const field = (label: string, value: string) => {
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#354862").text(label);
    doc.font("Helvetica").fontSize(12).fillColor("#182839").text(value || "Não informado", { lineGap: 3 });
    doc.moveDown(0.8);
  };
  const [year, month, day] = data.competence.split("-");

  doc.font("Helvetica-Bold").fontSize(23).fillColor("#152944").text("Conferência da DPS");
  doc.moveDown(0.35);
  doc.font("Helvetica").fontSize(11).fillColor("#354862").text("Declaração de Prestação de Serviços assinada localmente.");
  doc.moveDown(1.4);
  field("Identificador da DPS", data.id);
  field("Série e número", data.series + " / " + data.number);
  field("Competência", [day, month, year].join("/"));
  field("Assinatura local (horário de Brasília)", dateTime.format(preparedAt));
  field("CNPJ do prestador", data.cnpj);
  field("Tomador do serviço", data.customerName);
  field("CPF ou CNPJ do tomador", data.customerDocument);
  field("Código nacional do serviço", data.serviceCode);
  field("Valor do serviço", number.format(Number(data.amount)));
  field("Descrição do serviço", data.description);

  const { count } = doc.bufferedPageRange();
  for (let page = 0; page < count; page++) {
    doc.switchToPage(page);
    doc.rect(48, 28, doc.page.width - 96, 24).fill("#F8E9DA");
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#713C1C")
      .text("DPS DE TESTE - SEM VALOR FISCAL", 58, 36, { lineBreak: false });
    doc.font("Helvetica").fontSize(9).fillColor("#354862")
      .text("FiscalFlow   |   Conferência local   |   " + (page + 1) + "/" + count, 48, doc.page.height - 33, { lineBreak: false });
  }
  doc.end();
  return result;
}
