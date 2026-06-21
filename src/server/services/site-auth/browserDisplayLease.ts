type BrowserDisplayCleanup = () => Promise<void> | void;

const leases = new Map<string, BrowserDisplayCleanup>();
let leaseQueue: Promise<void> = Promise.resolve();

export async function acquireExclusiveBrowserDisplay(
  key: string,
  cleanup: BrowserDisplayCleanup,
): Promise<void> {
  const task = leaseQueue.then(async () => {
    for (const [existingKey, existingCleanup] of Array.from(leases.entries())) {
      if (existingKey === key) continue;
      leases.delete(existingKey);
      await Promise.resolve(existingCleanup()).catch(() => {});
    }
    leases.set(key, cleanup);
  });
  leaseQueue = task.catch(() => {});
  return task;
}

export function releaseBrowserDisplay(key: string): void {
  leases.delete(key);
}
