/** A row's tooltip: its title, which the row may cut short, above its address. */
export function itemTooltip(title: string, url?: string | null): string {
  const address = url?.trim();
  return address && address !== title ? `${title}\n${address}` : title;
}
