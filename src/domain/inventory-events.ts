export const inventoryDataChangedEvent = "uniform:inventory-data-changed";
let inventoryDataRevision = 0;

export function getInventoryDataRevision(): number {
  return inventoryDataRevision;
}

export function notifyInventoryDataChanged(): void {
  if (typeof window !== "undefined") {
    inventoryDataRevision += 1;
    window.dispatchEvent(new Event(inventoryDataChangedEvent));
  }
}

export function subscribeToInventoryDataChanges(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handleChange = () => listener();
  window.addEventListener(inventoryDataChangedEvent, handleChange);
  return () => window.removeEventListener(inventoryDataChangedEvent, handleChange);
}
