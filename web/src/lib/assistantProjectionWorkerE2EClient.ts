/** The routed multi-entry build's explicit one-shot projection Worker; see `buildProjection`. */
export function projectionWorker(): Worker {
  return new Worker('/assets/assistantProjectionWorker.js', { type: 'module' });
}
