export function contactNumber(value: unknown): string | null {
  if (typeof value !== "string" || !/^[+\d\s().-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  const full = value.trim().startsWith("+") ? digits
    : /^\d{10,11}$/.test(digits) ? "55" + digits : digits;
  return /^[1-9]\d{7,14}$/.test(full) ? full : null;
}

export function contactNumberLabel(value: unknown) {
  const number = contactNumber(value);
  if (!number) return typeof value === "string" ? value : "";
  return /^55\d{10,11}$/.test(number)
    ? number.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, "($1) $2-$3") : "+" + number;
}

export function maskContactNumber(value: string) {
  let digits = value.replace(/\D/g, "");
  if (value.trim().startsWith("+")) {
    if (!digits.startsWith("55") || digits.length < 4) return "+" + digits.slice(0, 15);
    digits = digits.slice(2);
  } else if (/^55\d{10,11}$/.test(digits)) digits = digits.slice(2);
  digits = digits.slice(0, 11);
  if (!digits) return "";
  const ddd = digits.slice(0, 2);
  const subscriber = digits.slice(2);
  const first = subscriber.length > 8 ? 5 : 4;
  return "(" + ddd + (ddd.length === 2 ? ")" : "") +
    (subscriber ? " " + subscriber.slice(0, first) : "") +
    (subscriber.length > first ? "-" + subscriber.slice(first) : "");
}

export function whatsappLink(value: unknown, message = "") {
  const number = contactNumber(value);
  return number ? "https://wa.me/" + number + (message ? "?text=" + encodeURIComponent(message) : "") : null;
}

export function emailLink(value: unknown, subject = "", body = "") {
  if (typeof value !== "string" || /[\r\n]/.test(value) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return "mailto:" + encodeURIComponent(value) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
}
