export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} não respondeu em ${Math.round(ms / 1000)} s.`);
    this.name = 'TimeoutError';
  }
}

/** Rejeita com TimeoutError se a promessa não terminar dentro do prazo. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
