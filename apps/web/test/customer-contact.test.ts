import assert from "node:assert/strict";
import { test } from "node:test";
import { contactNumber, contactNumberLabel, emailLink, maskContactNumber, whatsappLink } from "../src/registrations/contact.ts";

test("phone mask formats typing, pasted numbers and saved country codes without changing destinations", () => {
  for (const [raw, expected] of [["", ""], ["1", "(1"], ["11", "(11)"], ["119", "(11) 9"],
    ["11999990000", "(11) 99999-0000"], ["1133330000", "(11) 3333-0000"],
    ["+5511999990000", "(11) 99999-0000"], ["5511999990000", "(11) 99999-0000"],
    ["55999990000", "(55) 99999-0000"], ["+351912345678", "+351912345678"]]) {
    assert.equal(maskContactNumber(raw), expected);
    if (contactNumber(raw)) assert.equal(contactNumber(maskContactNumber(raw)), contactNumber(raw));
  }
});

test("contact links normalize national DDDs including 55 without duplicating the country code", () => {
  assert.equal(contactNumber("(11) 99999-0000"), "5511999990000");
  assert.equal(contactNumber("(55) 99999-0000"), "5555999990000");
  assert.equal(contactNumber("+55 (11) 3333-0000"), "551133330000");
  assert.equal(contactNumber("+351 912 345 678"), "351912345678");
  assert.equal(contactNumberLabel("+5511999990000"), "(11) 99999-0000");
  assert.equal(whatsappLink("+5511999990000", "Olá! R$ 10,00 & PDF"),
    "https://wa.me/5511999990000?text=" + encodeURIComponent("Olá! R$ 10,00 & PDF"));
});

test("invalid contacts cannot create executable URLs or add email headers", () => {
  for (const value of [null, "", "javascript:alert(1)", "11999", "11999990000?text=other"]) assert.equal(whatsappLink(value), null);
  assert.equal(emailLink("cliente@example.test\r\nbcc:other@example.test"), null);
  const uri = emailLink("cliente+financeiro@example.test", "Orçamento & serviço", "Olá!\nPDF em anexo.")!;
  assert.ok(uri.startsWith("mailto:cliente%2Bfinanceiro%40example.test?subject="));
  assert.ok(uri.includes("body=Ol%C3%A1!%0APDF%20em%20anexo."));
});
