export const inventoryDataChangedEvent = "uniform:inventory-data-changed";

export function notifyInventoryDataChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(inventoryDataChangedEvent));
  }
}
