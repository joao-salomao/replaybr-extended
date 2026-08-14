import { describe, expect, test } from "bun:test";
import { Semaphore } from "./semaphore.ts";

/** Lets pending microtasks/timers settle without a real sleep. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("Semaphore", () => {
  test("never lets concurrency exceed the limit", async () => {
    const sem = new Semaphore(2);
    let current = 0;
    let peak = 0;

    const task = async () => {
      const release = await sem.acquire();
      current++;
      peak = Math.max(peak, current);
      await tick();
      current--;
      release();
    };

    await Promise.all([task(), task(), task(), task(), task()]);

    expect(peak).toBeLessThanOrEqual(2);
  });

  test("resolves waiters in FIFO order", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const holdFirst = await sem.acquire();

    const waiterA = sem.acquire().then((release) => {
      order.push(1);
      release();
    });
    // Give `waiterA` a chance to actually enqueue before `waiterB` does.
    await tick();
    const waiterB = sem.acquire().then((release) => {
      order.push(2);
      release();
    });
    await tick();

    holdFirst();
    await Promise.all([waiterA, waiterB]);

    expect(order).toEqual([1, 2]);
  });

  test("a double release does not inflate the permit count", async () => {
    const sem = new Semaphore(1);

    const release = await sem.acquire();
    release();
    release(); // Second call: must be a no-op.

    // Both permits are now "out" from the semaphore's point of view only if
    // the double release actually inflated the count. With a correct
    // implementation there is still exactly 1 permit total, so a second
    // concurrent acquire must block until the first is released.
    const releaseA = await sem.acquire();
    let acquiredSecond = false;
    const pending = sem.acquire().then((releaseB) => {
      acquiredSecond = true;
      releaseB();
    });

    await tick();
    expect(acquiredSecond).toBe(false);

    releaseA();
    await pending;
    expect(acquiredSecond).toBe(true);
  });

  test("a released permit can be acquired again", async () => {
    const sem = new Semaphore(1);

    const release1 = await sem.acquire();
    release1();

    const release2 = await sem.acquire();
    release2();

    const release3 = await sem.acquire();
    release3();

    // No assertion needed beyond "this resolved" — a broken semaphore that
    // never gave the permit back would leave one of these `await`s hanging
    // and the test would time out.
    expect(true).toBe(true);
  });
});
