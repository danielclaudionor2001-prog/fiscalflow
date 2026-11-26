export const customerOrders = {
  name_asc: "Nome: A–Z",
  name_desc: "Nome: Z–A",
  newest: "Mais recentes",
  oldest: "Mais antigos",
};
export type CustomerOrder = keyof typeof customerOrders;

export function CustomerOrderSelect({ value, onChange }: { value: CustomerOrder; onChange: (value: CustomerOrder) => void }) {
  return <label>Ordenar clientes
    <select value={value} onChange={(event) => onChange(event.target.value as CustomerOrder)}>
      {Object.entries(customerOrders).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select>
  </label>;
}
