export interface RelayDeliveryStatus {
  ok: boolean;
  reason: string;
  checkedAt: number;
}

const deliveries = new Map<string, RelayDeliveryStatus>();
function key(url: string): string {
  try { return new URL(url).toString(); } catch { return url; }
}
export function recordRelayDelivery(url: string, ok: boolean, reason: string): void {
  deliveries.set(key(url), { ok, reason: reason.slice(0, 250), checkedAt: Date.now() });
}
export function getRelayDeliveryStatus(url: string): RelayDeliveryStatus | undefined {
  return deliveries.get(key(url));
}
