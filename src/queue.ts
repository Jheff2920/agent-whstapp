/** Ejecuta tareas en serie por clave (un cliente a la vez) y en paralelo entre claves distintas. */
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();

  constructor(private readonly onError: (err: unknown) => void = () => {}) {}

  enqueue(key: string, task: () => Promise<void>): void {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next: Promise<void> = prev
      .then(task)
      .catch((err) => this.onError(err))
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      });
    this.tails.set(key, next);
  }

  /** Espera a que no quede trabajo pendiente (útil en apagado y en pruebas). */
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all([...this.tails.values()]);
  }
}
