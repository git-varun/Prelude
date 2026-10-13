// The latest DATED item; an undated item is used only when no item has a date.
export function latestItem<T extends { as_of_date: string | null }>(items: T[]): T | null {
  let best: T | null = null;
  for (const it of items) {
    if (it.as_of_date !== null && (best === null || it.as_of_date >= (best.as_of_date as string))) best = it;
  }
  return best ?? items[items.length - 1] ?? null;
}
