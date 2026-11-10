import PDFDocument from "pdfkit";
import type { readLocalDpsSummary } from "../fiscal/documents.ts";

const dateTime = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short",
});
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const labelFont = "Helvetica-Bold";
const bodyFont = "Helvetica";
const ink = "#202020";
const rule = "#555555";
const margin = 18;
const padding = 6;
const labelSize = 7.5;
const bodySize = 9;
const sectionHeight = 15;
const lineGap = 1;
const retentionLabels = new Map([["1", "Não retido"], ["2", "Retido pelo tomador"]]);
type Cell = readonly [label: string, value: string, columns?: number];

function formatDocument(document: string) {
  return document.length === 11
    ? document.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4")
    : document.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, "$1.$2.$3/$4-$5");
}

function formatTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : dateTime.format(date);
}

export function dpsConferencePdf(data: ReturnType<typeof readLocalDpsSummary>, preparedAt: Date, organizationName: string) {
  const doc = new PDFDocument({
    size: "A4", margin, autoFirstPage: false, bufferPages: true,
    info: { Title: "Conferência da DPS - " + data.id, Creator: "FiscalFlow" },
  });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.once("end", () => resolve(Buffer.concat(chunks)));
    doc.once("error", reject);
  });
  let y = 0;
  const width = () => doc.page.width - 2 * margin;
  const footerTop = () => doc.page.height - margin - 34;

  function startPage() {
    doc.addPage();
    const w = width();
    doc.lineWidth(0.6).strokeColor(rule).rect(margin, margin, w, doc.page.height - 2 * margin).stroke();
    doc.rect(margin + 0.5, margin + 0.5, w - 1, 46).fill("#F0F0F0");
    doc.font(labelFont).fontSize(16).fillColor(ink)
      .text("FiscalFlow", margin + 7, margin + 12, { lineBreak: false });
    doc.font(labelFont).fontSize(12)
      .text("CONFERÊNCIA DA DPS", margin + w / 4, margin + 9, { width: w / 2, align: "center" });
    doc.font(bodyFont).fontSize(8)
      .text("Prévia no formato DANFSe v2.0", margin + w / 4, margin + 25, { width: w / 2, align: "center" });
    doc.font(labelFont).fontSize(8).fillColor("#8B241F")
      .text("SEM VALOR FISCAL", margin + w * 0.75, margin + 11, { width: w / 4 - padding, align: "right" });
    doc.font(bodyFont).fontSize(7.5).fillColor(ink)
      .text("DPS de teste | Homologação", margin + w * 0.75, margin + 26, { width: w / 4 - padding, align: "right" });
    y = margin + 47;
  }

  function heading(title: string) {
    doc.rect(margin + 0.5, y, width() - 1, sectionHeight).fill("#F0F0F0");
    doc.moveTo(margin, y).lineTo(margin + width(), y).strokeColor(rule).stroke();
    doc.font(labelFont).fontSize(8.5).fillColor(ink)
      .text(title, margin + padding, y + 3.5, { lineBreak: false });
    y += sectionHeight;
  }

  function measureRow(row: Cell[]) {
    const cells = row.map(([label, content, columns = 1]) => {
      const value = columns < 4 ? content.replace(/\s+/g, " ").trim() : content;
      const cellWidth = width() * columns / 4;
      const textWidth = cellWidth - 2 * padding;
      const labelHeight = doc.font(labelFont).fontSize(labelSize).heightOfString(label, { width: textWidth, lineGap });
      const bodyHeight = doc.font(bodyFont).fontSize(bodySize).heightOfString(value || "-", { width: textWidth, lineGap });
      return { label, value, cellWidth, textWidth, labelHeight, height: labelHeight + bodyHeight + 8 };
    });
    return { cells, height: Math.max(...cells.map((cell) => cell.height)) };
  }

  function drawRow(row: ReturnType<typeof measureRow>) {
    let x = margin;
    for (const cell of row.cells) {
      const options = { width: cell.textWidth, lineGap };
      doc.font(labelFont).fontSize(labelSize).fillColor(ink).text(cell.label, x + padding, y + 4, options);
      doc.font(bodyFont).fontSize(bodySize).text(cell.value || "-", x + padding, y + 4 + cell.labelHeight, options);
      x += cell.cellWidth;
    }
    y += row.height;
  }

  function section(title: string, rows: Cell[][], text?: readonly [string, string]) {
    for (const [index, fields] of rows.entries()) {
      const row = measureRow(fields);
      if (y + row.height + (index === 0 ? sectionHeight : 0) > footerTop() - 6) {
        startPage();
        if (index !== 0) heading(title + " (CONTINUAÇÃO)");
      }
      if (index === 0) heading(title);
      drawRow(row);
    }
    if (text) drawText(title, ...text);
  }

  function drawText(title: string, label: string, content: string) {
    let caption = label;
    while (true) {
      const measure = (value: string) => measureRow([[caption, value, 4]]);
      const available = footerTop() - 6 - y;
      const entire = measure(content);
      if (entire.height <= available) {
        drawRow(entire);
        return;
      }
      if (available >= 48) {
        let low = 1;
        let high = content.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (measure(content.slice(0, mid)).height <= available) low = mid;
          else high = mid - 1;
        }
        const newline = content.lastIndexOf("\n", low - 1);
        const boundary = newline >= low / 2 ? newline : content.lastIndexOf(" ", low - 1);
        const split = boundary >= low / 2 ? boundary + 1 : low;
        drawRow(measure(content.slice(0, split).trimEnd()));
        content = content.slice(split).trimStart();
        if (!content) return;
        caption = label + " (continuação)";
      }
      startPage();
      heading(title + " (CONTINUAÇÃO)");
    }
  }

  startPage();
  const [year, month, day] = data.competence.split("-");
  const competence = [day, month, year].join("/");
  const retention = retentionLabels.get(data.issRetention);

  section("IDENTIFICAÇÃO DA DPS", [
    [["Identificador da DPS", data.id, 3], ["Situação", "Assinada localmente"]],
    [["Número da DPS", data.number], ["Série da DPS", data.series], ["Competência", competence], ["Data e hora da DPS", formatTimestamp(data.issuedAt)]],
    [["Município de emissão (IBGE)", data.issuerCity], ["Assinatura local (Brasília)", dateTime.format(preparedAt)], ["NFS-e", "Aguardando autorização", 2]],
  ]);
  section("PRESTADOR / FORNECEDOR", [
    [["Nome / Nome empresarial", data.issuerName || organizationName, 2], ["CNPJ", formatDocument(data.cnpj)], ["Inscrição municipal", data.issuerRegistration]],
  ]);
  section("TOMADOR / ADQUIRENTE", [
    [["Nome / Nome empresarial", data.customerName, 2], ["CPF / CNPJ", formatDocument(data.customerDocument)], ["Inscrição municipal", data.customerRegistration]],
  ]);
  section("SERVIÇO PRESTADO", [
    [["Código nacional do serviço", data.serviceCode.replace(/^(\d{2})(\d{2})(\d{2})$/, "$1.$2.$3")],
      ["Código municipal", data.municipalServiceCode], ["Código NBS", data.nbs], ["Local da prestação (IBGE)", data.serviceCity]],
  ], ["Descrição do serviço", data.description]);
  section("TRIBUTAÇÃO MUNICIPAL (ISSQN)", [
    [["Retenção informada", retention ?? ""], ["Alíquota informada", data.issRate ? data.issRate.replace(".", ",") + "%" : ""],
      ["ISSQN apurado", "Disponível após autorização", 2]],
  ]);
  section("TRIBUTAÇÃO FEDERAL (EXCETO CBS)", [[["Apuração", "Disponível após autorização", 4]]]);
  section("TRIBUTAÇÃO IBS/CBS", [[["Apuração", "Disponível após autorização", 4]]]);
  section("VALORES DO SERVIÇO", [
    [["Valor da operação / serviço", currency.format(Number(data.amount)), 2], ["Valor líquido da NFS-e", "Disponível após autorização", 2]],
  ]);
  section("INFORMAÇÕES COMPLEMENTARES", [
    [["Conferência local", "Confira os dados antes da emissão. O DANFSe oficial é obtido após a autorização da NFS-e.", 4]],
  ], data.additionalInfo ? ["Informações da DPS", data.additionalInfo] : undefined);

  const { count } = doc.bufferedPageRange();
  for (let page = 0; page < count; page++) {
    doc.switchToPage(page);
    const w = width();
    const top = footerTop();
    doc.moveTo(margin, top).lineTo(margin + w, top).strokeColor(rule).stroke();
    for (const boundary of [0.25, 0.59]) {
      const x = margin + w * boundary;
      doc.moveTo(x, top).lineTo(x, doc.page.height - margin).stroke();
    }
    doc.font(labelFont).fontSize(7.5).fillColor(ink);
    doc.text("DATA DA CONFERÊNCIA", margin + padding, top + 5, { lineBreak: false });
    doc.text("IDENTIFICAÇÃO E ASSINATURA", margin + w * 0.25 + padding, top + 5, { lineBreak: false });
    doc.text("SEM VALOR FISCAL", margin + w * 0.59 + padding, top + 5, { lineBreak: false });
    doc.font(bodyFont).fontSize(8).text("DPS " + data.number + " / Série " + data.series + " | " + (page + 1) + "/" + count,
      margin + w * 0.59 + padding, top + 18, { lineBreak: false });
  }
  doc.end();
  return result;
}
