// Layers-panel fixture: a static list of DISTINCT siblings (the direct-move
// path — each <li> is its own JSX literal) and a .map()-rendered list (every
// rendered <li> shares the SAME source stamp — the needsAgent path).
export function StaticList(): JSX.Element {
  return (
    <ul id="static-list">
      <li>Alpha</li>
      <li>Beta</li>
      <li>Gamma</li>
    </ul>
  )
}

export function MappedList({ items }: { items: string[] }): JSX.Element {
  return (
    <ul id="mapped-list">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}
