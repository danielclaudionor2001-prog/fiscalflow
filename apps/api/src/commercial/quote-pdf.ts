import PDFDocument from "pdfkit";
import { usableCommercialLogo } from "../organizations/branding.ts";

type QuotePdfData = {
  id: string;
  customerName: string | null;
  createdAt: Date;
  dueOn: Date | null;
  sellerName: string | null;
  items: { label: string; quantity: number; unitPrice: string; subtotal: string }[];
  note: string;
  amount: string;
};
type QuoteBrand = {
  legalName: string; tradeName: string | null; cnpj: string | null; commercialLogo: Uint8Array | null;
  commercialEmail: string | null; commercialPhone: string | null; commercialAddress: string | null; quoteWatermark: boolean;
};

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const integer = new Intl.NumberFormat("pt-BR");
const dateInBrasilia = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" });
const civilDate = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" });
const ink = "#14263E";
const muted = "#495D74";
const accent = "#0F665F";
const pale = "#ECF6F4";
const border = "#D8E4E9";
const margin = 44;
const regular = "Helvetica";
const bold = "Helvetica-Bold";
const lineGap = 2;

export function quotePdf(order: QuotePdfData, brand: QuoteBrand) {
  const reference = order.id.slice(-8).toUpperCase();
  const doc = new PDFDocument({
    size: "A4", margin, autoFirstPage: false, bufferPages: true,
    info: { Title: "Orçamento " + reference, Author: brand.legalName, Creator: "Fiscal Floow" },
  });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.once("end", () => resolve(Buffer.concat(chunks)));
    doc.once("error", reject);
  });
  try {
    const storedLogo = brand.commercialLogo ? Buffer.from(brand.commercialLogo) : null;
    const logo = storedLogo && usableCommercialLogo(storedLogo) ? storedLogo : null;
    const width = 595.28 - 2 * margin;
    const pageEnd = 767;
    const columns = [width - 270, 50, 110, 110];
    let y = 0;

    function startPage(first: boolean) {
      doc.addPage();
      if (logo && brand.quoteWatermark) doc.save().opacity(.10)
        .image(logo, margin, 255, { fit: [width, 300], align: "center", valign: "center" }).restore();
      doc.rect(margin, margin, width, 4).fill(accent);
      const brandOffset = logo ? 102 : 0;
      if (logo) doc.image(logo, margin, 62, { fit: [84, 62] });
      const brandWidth = width - brandOffset;
      const brandX = margin + brandOffset;
      const businessName = brand.tradeName || brand.legalName;
      doc.font(bold).fontSize(16).fillColor(ink)
        .text(businessName, brandX, 63, { width: brandWidth, lineGap });
      const legalName = brand.tradeName && brand.tradeName !== brand.legalName ? brand.legalName : null;
      const formattedCnpj = brand.cnpj?.replace(/[./-]/g, "").replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, "$1.$2.$3/$4-$5");
      const contacts = [brand.commercialPhone, brand.commercialEmail].filter(Boolean).join("  ·  ");
      for (const detail of [legalName, formattedCnpj && "CNPJ " + formattedCnpj, contacts, brand.commercialAddress]) {
        if (detail) doc.font(regular).fontSize(9).fillColor(muted)
          .text(detail, brandX, doc.y + 3, { width: brandWidth, lineGap });
      }
      y = Math.max(logo ? 138 : 105, doc.y + 14);
      doc.font(bold).fontSize(first ? 30 : 18).fillColor(ink).text("Orçamento", margin, y, { width: width - 95 });
      doc.font(bold).fontSize(10).fillColor(accent).text(reference, margin + width - 95, y + (first ? 13 : 5), {
        align: "right", width: 95, lineBreak: false,
      });
      y += first ? 48 : 37;
    }

    function rule(at: number) {
      doc.moveTo(margin, at).lineTo(margin + width, at).lineWidth(.6).strokeColor(border).stroke();
    }

    function itemHeading() {
      doc.roundedRect(margin, y, width, 26, 5).fill(pale);
      let x = margin;
      for (const [index, label] of ["Descrição", "Qtd.", "Valor unitário", "Subtotal"].entries()) {
        doc.font(bold).fontSize(9).fillColor(accent).text(label, x + 9, y + 8, {
          width: columns[index] - 18, align: index === 0 ? "left" : "right", lineBreak: false,
        });
        x += columns[index];
      }
      y += 26;
    }

    startPage(true);
    const facts = [
      ["Cliente", order.customerName || "Cliente avulso"],
      ["Data do orçamento", dateInBrasilia.format(order.createdAt)],
      ["Validade", order.dueOn ? civilDate.format(order.dueOn) : "Consulte o fornecedor"],
    ];
    let x = margin;
    let factsBottom = y;
    for (const [index, [label, value]] of facts.entries()) {
      const cell = index === 0 ? width - 220 : 110;
      doc.font(bold).fontSize(8).fillColor(muted).text(label, x, y, { width: cell - 14, lineBreak: false });
      doc.font(bold).fontSize(11).fillColor(ink).text(value, x, y + 13, { width: cell - 14, lineGap });
      factsBottom = Math.max(factsBottom, doc.y);
      x += cell;
    }
    y = factsBottom + 16;
    if (order.sellerName) {
      doc.font(regular).fontSize(9).fillColor(muted).text("Responsável: " + order.sellerName, margin, y, { width, lineGap });
      y = doc.y + 13;
    }
    itemHeading();

    for (const item of order.items) {
      const textHeight = doc.font(regular).fontSize(10).heightOfString(item.label, { width: columns[0] - 18, lineGap });
      const rowHeight = Math.max(32, textHeight + 16);
      if (y + rowHeight > pageEnd) {
        startPage(false);
        itemHeading();
      }
      let cellX = margin;
      const values = [item.label, integer.format(item.quantity), currency.format(Number(item.unitPrice)), currency.format(Number(item.subtotal))];
      for (const [index, value] of values.entries()) {
        doc.font(index === 3 ? bold : regular).fontSize(10).fillColor(ink).text(value, cellX + 9, y + 9, {
          width: columns[index] - 18, align: index === 0 ? "left" : "right", lineGap,
        });
        cellX += columns[index];
      }
      y += rowHeight;
      rule(y);
    }

    if (y + 75 > pageEnd) startPage(false);
    y += 18;
    doc.roundedRect(margin, y, width, 53, 7).fill(pale);
    doc.font(bold).fontSize(11).fillColor(accent).text("Valor total", margin + 15, y + 21, { lineBreak: false });
    doc.font(bold).fontSize(21).fillColor(ink).text(currency.format(Number(order.amount)), margin + 140, y + 15, {
      width: width - 156, align: "right", lineBreak: false,
    });
    y += 72;

    if (order.note) {
      let note = order.note;
      let heading = "Observações";
      const heightOf = (value: string) => doc.font(regular).fontSize(10).heightOfString(value, { width, lineGap });
      while (note) {
        if (pageEnd - y < 64) startPage(false);
        const available = pageEnd - y - 20;
        let end = note.length;
        while (heightOf(note.slice(0, end)) > available) end = Math.floor(end * .8);
        if (end < note.length) {
          const boundary = Math.max(note.lastIndexOf(" ", end), note.lastIndexOf("\n", end));
          if (boundary > end / 2) end = boundary;
        }
        doc.font(bold).fontSize(11).fillColor(ink).text(heading, margin, y, { lineBreak: false });
        doc.font(regular).fontSize(10).fillColor(muted).text(note.slice(0, end).trimEnd(), margin, y + 20, { width, lineGap });
        note = note.slice(end).trimStart();
        if (note) {
          startPage(false);
          heading = "Observações (continuação)";
        }
      }
    }

    const pages = doc.bufferedPageRange().count;
    for (let index = 0; index < pages; index++) {
      doc.switchToPage(index);
      rule(781);
      doc.font(regular).fontSize(8).fillColor(muted)
        .text("Documento comercial · Sem valor fiscal", margin, 789, { lineBreak: false });
      const number = (index + 1) + " / " + pages;
      doc.text(number, margin + width - doc.widthOfString(number), 789, { lineBreak: false });
    }
    doc.end();
  } catch (error) {
    doc.destroy(error instanceof Error ? error : new Error("PDF generation failed"));
  }
  return result;
}
