import { AsyncLocalStorage } from 'node:async_hooks';

const accountProfileLeaseTails = new Map<number, Promise<void>>();
const heldAccountProfileLeases = new AsyncLocalStorage<ReadonlySet<number>>();

export async function withAccountBrowserProfileLease<T>(
  accountId: number,
  work: () => Promise<T>,
): Promise<T> {
  const inheritedLeases = heldAccountProfileLeases.getStore();
  if (inheritedLeases?.has(accountId)) return work();

  const previous = accountProfileLeaseTails.get(accountId) ?? Promise.resolve();
  let release!: () => void;
  const currentGate = new Promise<void>((resolve) => { release = resolve; });
  const currentTail = previous.catch(() => undefined).then(() => currentGate);
  accountProfileLeaseTails.set(accountId, currentTail);

  await previous.catch(() => undefined);
  const activeLeases = new Set(inheritedLeases || []);
  activeLeases.add(accountId);
  try {
    return await heldAccountProfileLeases.run(activeLeases, work);
  } finally {
    release();
    if (accountProfileLeaseTails.get(accountId) === currentTail) {
      accountProfileLeaseTails.delete(accountId);
    }
  }
}
