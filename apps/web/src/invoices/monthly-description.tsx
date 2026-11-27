export function MonthlyDescriptionOption({ enabled, description, toggle, changeDescription }: {
  enabled: boolean; description: string; toggle: (enabled: boolean) => void; changeDescription: (description: string) => void;
}) {
  return <div className="monthly-description-option">
    <label className="record-checkbox"><input type="checkbox" checked={enabled} onChange={(event) => {
      const checked = event.target.checked;
      toggle(checked);
      if (checked && !/DO M[ÊE]S DE /i.test(description)) {
        const month = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", month: "long" }).format(new Date()).toLocaleUpperCase("pt-BR");
        changeDescription(`PRESTAÇÃO DE SERVIÇOS E DE MANUTENÇÃO PREVENTIVA E CORRETIVA DO MÊS DE ${month}, CONFORME CONTRATO DE MANUTENÇÃO MENSAL DOS ELEVADORES.`);
      }
    }} /> Atualizar o mês anterior na descrição da manutenção</label>
    <small className="record-hint">O mês citado no texto será atualizado ao preparar cada nota. Exemplo: emissão em dezembro menciona NOVEMBRO; emissão em janeiro menciona DEZEMBRO. A competência continua no mês da emissão.</small>
  </div>;
}
