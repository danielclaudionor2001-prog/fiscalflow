import { z } from "zod";

export const contactPhoneInput = z.string().trim().max(32)
  .regex(/^[+\d\s().-]*$/)
  .transform((text) => {
    if (!text) return null;
    const digits = text.replace(/\D/g, "");
    return text.startsWith("+") ? "+" + digits
      : /^\d{10,11}$/.test(digits) ? "+55" + digits
        : /^55\d{10,11}$/.test(digits) ? "+" + digits : digits;
  }).refine((value) => value === null || /^\+[1-9]\d{7,14}$/.test(value),
    "Informe DDD e número, ou + e o código do país.")
  .nullable().optional();
