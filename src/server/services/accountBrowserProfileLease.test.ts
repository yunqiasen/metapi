import { describe, expect, it } from 'vitest';
import { withAccountBrowserProfileLease } from './accountBrowserProfileLease.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('withAccountBrowserProfileLease', () => {
  it('serializes browser profile work for the same account', async () => {
    const releaseFirst = deferred();
    const firstStarted = deferred();
    const entered: number[] = [];

    const first = withAccountBrowserProfileLease(94, async () => {
      entered.push(1);
      firstStarted.resolve();
      await releaseFirst.promise;
      return 'first';
    });
    const second = withAccountBrowserProfileLease(94, async () => {
      entered.push(2);
      return 'second';
    });

    await firstStarted.promise;
    expect(entered).toEqual([1]);
    releaseFirst.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(entered).toEqual([1, 2]);
  });

  it('allows nested work for the same account without deadlocking the outer operation', async () => {
    const result = await Promise.race([
      withAccountBrowserProfileLease(94, async () => (
        withAccountBrowserProfileLease(94, async () => 'nested-complete')
      )),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);

    expect(result).toBe('nested-complete');
  });

  it('allows browser profile work for different accounts to run concurrently', async () => {
    const release = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const entered: number[] = [];

    const first = withAccountBrowserProfileLease(95, async () => {
      entered.push(95);
      firstStarted.resolve();
      await release.promise;
    });
    const second = withAccountBrowserProfileLease(96, async () => {
      entered.push(96);
      secondStarted.resolve();
      await release.promise;
    });

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    expect(entered.sort()).toEqual([95, 96]);
    release.resolve();
    await Promise.all([first, second]);
  });

  it('releases the account lease after work throws', async () => {
    await expect(withAccountBrowserProfileLease(97, async () => {
      throw new Error('browser crashed');
    })).rejects.toThrow('browser crashed');

    await expect(withAccountBrowserProfileLease(97, async () => 'recovered')).resolves.toBe('recovered');
  });
});
