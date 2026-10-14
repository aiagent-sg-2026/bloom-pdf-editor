import { describe, expect, it, vi } from 'vitest';
import { commitThenCleanup } from './commit-after-success';

describe('commitThenCleanup', () => {
  it('propagates a failed commit without running cleanup', async () => {
    const error = new Error('content update failed');
    const commit = vi.fn(async () => {
      throw error;
    });
    const cleanup = vi.fn();

    await expect(commitThenCleanup(commit, cleanup)).rejects.toBe(error);
    expect(commit).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('runs cleanup once after a successful commit', async () => {
    const events: string[] = [];
    const commit = vi.fn(async () => {
      events.push('commit');
    });
    const cleanup = vi.fn(() => {
      events.push('cleanup');
    });

    await commitThenCleanup(commit, cleanup);
    expect(events).toEqual(['commit', 'cleanup']);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
