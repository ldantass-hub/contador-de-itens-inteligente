export function removeScanEntry<T extends { id: string; isError: boolean }>(
  items: T[],
  rawLines: string[],
  itemId: string,
): { items: T[]; rawLines: string[] } {
  const itemIndex = items.findIndex(item => item.id === itemId);
  if (itemIndex < 0 || items[itemIndex].isError || items.length !== rawLines.length) {
    return { items, rawLines };
  }

  const rawLineIndex = items.length - itemIndex - 1;
  return {
    items: items.filter(item => item.id !== itemId),
    rawLines: rawLines.filter((_, index) => index !== rawLineIndex),
  };
}