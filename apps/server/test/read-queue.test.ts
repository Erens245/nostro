// The public testnet RPC answers 429 to bursts. On 8 Nov a preview failed with
// "Something went wrong" because of it. Reads now queue and wait it out.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ReadQueue, isRateLimited } from '../src/chain.ts';

const rateLimited = (): Error =>
  Object.assign(
    new Error('{"jsonrpc": "2.0", "error": {"code": -429, "message": "Rate limits exceeded."}, "id": "1"}'),
    { cause: 429 },
  );

describe('reads against a rate-limited RPC', () => {
  test('recognises the RPC refusal, and nothing else', () => {
    assert.equal(isRateLimited(rateLimited()), true);
    assert.equal(isRateLimited(Object.assign(new Error('Too busy'), { cause: 429 })), true);
    assert.equal(isRateLimited(new Error('Smart contract panicked: E_NOT_APPROVED')), false);
    assert.equal(isRateLimited(new Error('Server error 500')), false);
  });

  test('waits out a 429 and then returns the answer', async () => {
    const waits: number[] = [];
    const queue = new ReadQueue(2, [10, 20, 30], async (ms) => {
      waits.push(ms);
    });
    let calls = 0;
    const value = await queue.run(async () => {
      calls += 1;
      if (calls < 3) throw rateLimited();
      return 'ledger';
    });
    assert.equal(value, 'ledger');
    assert.deepEqual(waits, [10, 20]);
  });

  test('does not retry an error that waiting will not fix', async () => {
    const queue = new ReadQueue(2, [10, 20], async () => {});
    let calls = 0;
    await assert.rejects(
      queue.run(async () => {
        calls += 1;
        throw new Error('Smart contract panicked: E_NOT_APPROVED');
      }),
      /E_NOT_APPROVED/,
    );
    assert.equal(calls, 1);
  });

  test('gives up when the RPC stays limited', async () => {
    const queue = new ReadQueue(2, [10, 20], async () => {});
    let calls = 0;
    await assert.rejects(
      queue.run(async () => {
        calls += 1;
        throw rateLimited();
      }),
      /Rate limits exceeded/,
    );
    assert.equal(calls, 3);
  });

  test('never runs more reads at once than allowed, and finishes them all', async () => {
    const queue = new ReadQueue(2, [10], async () => {});
    let running = 0;
    let most = 0;
    const read = (index: number) =>
      queue.run(async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((done) => setTimeout(done, 5));
        running -= 1;
        return index;
      });
    const results = await Promise.all(Array.from({ length: 9 }, (_, index) => read(index)));
    assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(most, 2);
  });

  test('a failed read frees its slot for the next one', async () => {
    const queue = new ReadQueue(1, [], async () => {});
    await assert.rejects(queue.run(async () => Promise.reject(new Error('boom'))));
    assert.equal(await queue.run(async () => 'next'), 'next');
  });
});
