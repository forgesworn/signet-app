/** Bound network work without leaving timer handles after a quick response. */
export function relayTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Relay operation timed out')), timeoutMs);
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/** Return on the first acknowledgement. Other deliveries continue and all
 * rejections remain handled. False requires every attempt to finish. */
export async function anyRelayAccepted(attempts: Promise<boolean>[]): Promise<boolean> {
  if (!attempts.length) return false;
  try {
    await Promise.any(attempts.map(async attempt => {
      if (!await attempt) throw new Error('Relay refused the event');
    }));
    return true;
  } catch { return false; }
}
