import { describe, expect, it } from 'vitest';
import { DocumentSession } from '../session/document-session';

const bytes = (...values: number[]) => new Uint8Array(values);

async function commit(session: DocumentSession, value: number): Promise<void> {
  const transaction = session.beginTransaction(`edit-${value}`);
  await transaction.apply(async () => bytes(value));
  transaction.commit();
}

describe('DocumentSession', () => {
  it('publishes bytes and advances revision only after commit', async () => {
    const session = new DocumentSession(bytes(1));
    const transaction = session.beginTransaction('replace-image');
    await transaction.apply(async input => {
      input[0] = 2;
      return input;
    });
    await transaction.apply(async input => bytes(input[0], 3));
    expect(session.getBytes()).toEqual(bytes(1));
    expect(session.revision).toBe(0);
    expect(session.canUndo).toBe(false);

    transaction.commit();
    expect(session.getBytes()).toEqual(bytes(2, 3));
    expect(session.revision).toBe(1);
    expect(session.canUndo).toBe(true);
  });

  it('discards successful work on explicit rollback', async () => {
    const session = new DocumentSession(bytes(1));
    const transaction = session.beginTransaction('watermark');
    await transaction.apply(async () => bytes(2));
    transaction.rollback();
    expect(session.getBytes()).toEqual(bytes(1));
    expect(session.revision).toBe(0);
    expect(session.canUndo).toBe(false);
    await commit(session, 3);
    expect(session.getBytes()).toEqual(bytes(3));
  });

  it('aborts the entire transaction when apply mutates its input and throws', async () => {
    const session = new DocumentSession(bytes(1));
    const transaction = session.beginTransaction('failed edit');
    await transaction.apply(async () => bytes(2));
    const failure = new Error('decode failed');
    await expect(transaction.apply(async input => {
      input[0] = 9;
      throw failure;
    })).rejects.toBe(failure);
    expect(session.getBytes()).toEqual(bytes(1));
    expect(session.revision).toBe(0);
    expect(session.canUndo).toBe(false);
    expect(() => transaction.commit()).toThrow(/closed/i);
    transaction.rollback();
    await commit(session, 3);
    expect(session.getBytes()).toEqual(bytes(3));
  });

  it('restores byte snapshots in undo/redo order with monotonic revisions', async () => {
    const session = new DocumentSession(bytes(1));
    await commit(session, 2);
    await commit(session, 3);
    expect(session.undo()).toEqual(bytes(2));
    expect(session.undo()).toEqual(bytes(1));
    expect(session.undo()).toBeNull();
    expect(session.canUndo).toBe(false);
    expect(session.redo()).toEqual(bytes(2));
    expect(session.redo()).toEqual(bytes(3));
    expect(session.redo()).toBeNull();
    expect(session.canRedo).toBe(false);
    expect(session.revision).toBe(6);
  });

  it('clears redo only when a new edit commits, not when it rolls back', async () => {
    const session = new DocumentSession(bytes(1));
    await commit(session, 2);
    session.undo();
    const cancelled = session.beginTransaction('cancelled');
    await cancelled.apply(async () => bytes(9));
    cancelled.rollback();
    expect(session.canRedo).toBe(true);
    await commit(session, 3);
    expect(session.canRedo).toBe(false);
    expect(session.redo()).toBeNull();
    expect(session.undo()).toEqual(bytes(1));
  });

  it('rejects nested and concurrent transactions until the active one closes', async () => {
    const session = new DocumentSession(bytes(1));
    const first = session.beginTransaction('first');
    const { promise, resolve: release } = Promise.withResolvers<Uint8Array>();
    const pending = first.apply(() => promise);
    expect(() => session.beginTransaction('second')).toThrow(/transaction.*active/i);
    expect(() => first.commit()).toThrow(/apply.*pending/i);
    await expect(first.apply(async () => bytes(3))).rejects.toThrow(/apply.*pending/i);
    expect(() => session.undo()).toThrow(/transaction.*active/i);
    expect(() => session.snapshot('checkpoint')).toThrow(/transaction.*active/i);
    release(bytes(2));
    await pending;
    first.commit();
    expect(() => first.commit()).toThrow(/closed/i);
    session.beginTransaction('third').rollback();
  });

  it('does not publish an in-flight apply after rollback', async () => {
    const session = new DocumentSession(bytes(1));
    const transaction = session.beginTransaction('slow edit');
    const { promise, resolve: release } = Promise.withResolvers<Uint8Array>();
    const pending = transaction.apply(() => promise);
    transaction.rollback();
    await commit(session, 3);
    release(bytes(2));
    await expect(pending).rejects.toThrow(/closed/i);
    expect(session.getBytes()).toEqual(bytes(3));
    expect(session.revision).toBe(1);
  });

  it('notifies subscribers once per commit and supports unsubscribe', async () => {
    const session = new DocumentSession(bytes(1));
    const observed: Array<[number, number]> = [];
    const unsubscribe = session.subscribe(() => {
      observed.push([session.revision, session.getBytes()[0]]);
    });
    const transaction = session.beginTransaction('two steps');
    await transaction.apply(async () => bytes(2));
    await transaction.apply(async () => bytes(3));
    expect(observed).toEqual([]);
    transaction.commit();
    expect(observed).toEqual([[1, 3]]);
    session.beginTransaction('cancelled').rollback();
    expect(observed).toEqual([[1, 3]]);
    unsubscribe();
    await commit(session, 4);
    expect(observed).toEqual([[1, 3]]);
  });

  it('isolates owned bytes from caller buffers and reads', async () => {
    const initial = bytes(1);
    const session = new DocumentSession(initial);
    initial[0] = 9;
    session.getBytes()[0] = 8;
    const output = bytes(2);
    const transaction = session.beginTransaction('owned result');
    await transaction.apply(async () => output);
    output[0] = 7;
    transaction.commit();
    expect(session.getBytes()).toEqual(bytes(2));
    session.undo()![0] = 6;
    expect(session.getBytes()).toEqual(bytes(1));
    session.redo()![0] = 5;
    expect(session.getBytes()).toEqual(bytes(2));
  });

  it('records checkpoints for legacy bytes without losing earlier undo order', async () => {
    const session = new DocumentSession(bytes(1));
    await commit(session, 2);
    session.snapshot('legacy edit', bytes(3));
    await commit(session, 4);
    expect(session.undo()).toEqual(bytes(3));
    expect(session.undo()).toEqual(bytes(2));
    expect(session.undo()).toEqual(bytes(1));
  });
});
