/** Create the one-shot projection Worker. Kept behind a lazy boundary so reduced Tizen never packages it. */
export function projectionWorker(): Worker {
  return new Worker(new URL('./assistantProjectionWorker.ts', import.meta.url), {
    type: 'module',
  });
}
