import { useId, useLayoutEffect, useRef, useState, type ChangeEvent, type ComponentPropsWithoutRef, type KeyboardEvent } from "react";
import { civilDateLabel, maskDate, maskDocument, parseBrazilianDate } from "./format";

function applyMask(input: HTMLInputElement, format: (value: string) => string) {
  const { value, selectionStart } = input;
  const formatted = format(value);
  if (formatted === value) return formatted;

  const position = (value.slice(0, selectionStart ?? value.length).match(/[A-Za-z0-9]/g) ?? []).length;
  let caret = 0;
  let consumed = 0;
  while (caret < formatted.length && consumed < position) {
    if (/[A-Za-z0-9]/.test(formatted[caret])) consumed++;
    caret++;
  }
  input.value = formatted;
  input.setSelectionRange(caret, caret);
  return formatted;
}

function skipSeparator(event: KeyboardEvent<HTMLInputElement>) {
  const input = event.currentTarget;
  const { selectionStart: start, selectionEnd: end, value } = input;
  if (start === null || start !== end) return;
  if (event.key === "Backspace" && /[.\/\-]/.test(value[start - 1] ?? "")) {
    input.setSelectionRange(start - 1, start - 1);
  } else if (event.key === "Delete" && /[.\/\-]/.test(value[start] ?? "")) {
    input.setSelectionRange(start + 1, start + 1);
  }
}

type DocumentProps = Omit<ComponentPropsWithoutRef<"input">, "type" | "value" | "defaultValue" | "onChange"> & {
  mode?: "cpf" | "cnpj" | "either";
  defaultValue?: string;
};

const cpf = "[0-9]{3}[.][0-9]{3}[.][0-9]{3}\\x2d[0-9]{2}";
const cnpj = "[A-Z0-9]{2}[.][A-Z0-9]{3}[.][A-Z0-9]{3}\\x2f[A-Z0-9]{4}\\x2d[0-9]{2}";

export function DocumentInput({ mode = "either", defaultValue, ...props }: DocumentProps) {
  const format = (value: string) => maskDocument(value, mode);
  const placeholder = mode === "cpf" ? "000.000.000-00" : mode === "cnpj" ? "00.000.000/0000-00" : "CPF ou CNPJ";
  return <input {...props} type="text" inputMode={mode === "cpf" ? "numeric" : "text"} placeholder={placeholder}
    autoCapitalize="characters" spellCheck={false} defaultValue={defaultValue && format(defaultValue)}
    pattern={mode === "cpf" ? cpf : mode === "cnpj" ? cnpj : cpf + "|" + cnpj}
    title={mode === "either" ? "000.000.000-00 ou 00.000.000/0000-00" : placeholder}
    onChange={(event) => applyMask(event.currentTarget, format)} onKeyDown={skipSeparator} />;
}

type DateProps = {
  label: string;
  className?: string;
  name?: string;
  defaultValue?: string;
  required?: boolean;
  min?: string;
  max?: string;
  onDateChange?: (date: string) => void;
};

export function DateInput({ label, className, name, defaultValue = "", required, min, max, onDateChange }: DateProps) {
  const id = useId();
  const [text, setText] = useState(() => civilDateLabel(defaultValue));
  const visible = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const iso = parseBrazilianDate(text);
  const canOpenCalendar = typeof HTMLInputElement.prototype.showPicker === "function";

  useLayoutEffect(() => {
    let message = "";
    if (text && !iso) message = "Informe uma data válida no formato DD/MM/AAAA.";
    else if (iso && min && iso < min) message = "Informe uma data a partir de " + civilDateLabel(min) + ".";
    else if (iso && max && iso > max) message = "Informe uma data até " + civilDateLabel(max) + ".";
    visible.current?.setCustomValidity(message);
  }, [iso, max, min, text]);

  function update(value: string) {
    setText(value);
    onDateChange?.(parseBrazilianDate(value));
  }

  function openCalendar() {
    // Older or restricted browsers can still use the text field.
    try { picker.current?.showPicker(); }
    catch { visible.current?.focus(); }
  }

  return <div className={className ? "date-control " + className : "date-control"}>
    <label htmlFor={id}>{label}</label>
    <span className="date-field">
      <input id={id} ref={visible} type="text" inputMode="numeric" value={text} placeholder="DD/MM/AAAA" required={required}
        onChange={(event: ChangeEvent<HTMLInputElement>) => update(applyMask(event.currentTarget, maskDate))}
        onKeyDown={skipSeparator} />
      {name && <input type="hidden" name={name} value={iso} />}
      {canOpenCalendar && <>
        <button type="button" className="button-secondary date-field-button" aria-label="Abrir calendário" onClick={openCalendar}>
          <span aria-hidden="true">▦</span>
        </button>
        <input className="date-field-picker" ref={picker} type="date" tabIndex={-1} aria-hidden="true"
          value={iso} min={min} max={max} onChange={(event) => update(civilDateLabel(event.currentTarget.value))} />
      </>}
    </span>
  </div>;
}
