export class KeyedSerialExecutor {
  private readonly queues = new Map<string, Promise<void>>();

  run(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this.queues.get(key) === current) this.queues.delete(key);
      });
    this.queues.set(key, current);
    return current;
  }
}
