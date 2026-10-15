export class EditTransaction {
  private closed = false;
  private applying = false;

  constructor(
    private bytes: Uint8Array,
    private readonly publish: (bytes: Uint8Array) => void,
    private readonly release: () => void,
  ) {}

  /** Each step receives private bytes; neither input nor output aliases the session. */
  async apply(fn: (bytes: Uint8Array) => Promise<Uint8Array>): Promise<void> {
    if (this.closed) throw new Error('Edit transaction is closed');
    if (this.applying) throw new Error('Transaction apply is pending');
    this.applying = true;
    try {
      const result = await fn(this.bytes);
      if (this.closed) throw new Error('Edit transaction is closed');
      this.bytes = new Uint8Array(result);
    } catch (error) {
      this.rollback();
      throw error;
    } finally {
      this.applying = false;
    }
  }

  commit(): void {
    if (this.closed) throw new Error('Edit transaction is closed');
    if (this.applying) throw new Error('Transaction apply is pending');
    this.closed = true;
    this.release();
    this.publish(this.bytes);
  }

  /** Idempotent, including after an apply failure or while apply is pending. */
  rollback(): void {
    if (this.closed) return;
    this.closed = true;
    this.bytes = new Uint8Array();
    this.release();
  }
}
