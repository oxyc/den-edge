import AssistantProjectionWorker from './assistantProjectionWorker?worker';

/** Create the one-shot projection Worker. Kept behind a lazy boundary so reduced Tizen never packages it. */
export function projectionWorker(): Worker {
  return new AssistantProjectionWorker();
}
