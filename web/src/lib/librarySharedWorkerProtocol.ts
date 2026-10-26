/** Bumped independently from domain messages when the SharedWorker connection lifecycle changes. */
export const LIBRARY_SHARED_WORKER_PROTOCOL = 1 as const;

export interface SharedWorkerDisconnect {
  type: 'den-library-disconnect';
  protocol: typeof LIBRARY_SHARED_WORKER_PROTOCOL;
}

export interface SharedWorkerConnected {
  type: 'den-library-connected';
  protocol: typeof LIBRARY_SHARED_WORKER_PROTOCOL;
}

export interface SharedWorkerHeartbeat {
  type: 'den-library-heartbeat';
  protocol: typeof LIBRARY_SHARED_WORKER_PROTOCOL;
}

export interface SharedWorkerHeartbeatAck {
  type: 'den-library-heartbeat-ack';
  protocol: typeof LIBRARY_SHARED_WORKER_PROTOCOL;
}

export interface SharedWorkerPresence {
  type: 'den-library-suspend' | 'den-library-resume';
  protocol: typeof LIBRARY_SHARED_WORKER_PROTOCOL;
}

export const isSharedWorkerConnected = (value: unknown): value is SharedWorkerConnected =>
  typeof value === 'object' &&
  value !== null &&
  (value as { type?: unknown }).type === 'den-library-connected' &&
  (value as { protocol?: unknown }).protocol === LIBRARY_SHARED_WORKER_PROTOCOL;

export const isSharedWorkerDisconnect = (value: unknown): value is SharedWorkerDisconnect =>
  typeof value === 'object' &&
  value !== null &&
  (value as { type?: unknown }).type === 'den-library-disconnect' &&
  (value as { protocol?: unknown }).protocol === LIBRARY_SHARED_WORKER_PROTOCOL;

export const isSharedWorkerHeartbeat = (value: unknown): value is SharedWorkerHeartbeat =>
  typeof value === 'object' &&
  value !== null &&
  (value as { type?: unknown }).type === 'den-library-heartbeat' &&
  (value as { protocol?: unknown }).protocol === LIBRARY_SHARED_WORKER_PROTOCOL;

export const isSharedWorkerHeartbeatAck = (value: unknown): value is SharedWorkerHeartbeatAck =>
  typeof value === 'object' &&
  value !== null &&
  (value as { type?: unknown }).type === 'den-library-heartbeat-ack' &&
  (value as { protocol?: unknown }).protocol === LIBRARY_SHARED_WORKER_PROTOCOL;

export const isSharedWorkerPresence = (value: unknown): value is SharedWorkerPresence =>
  typeof value === 'object' &&
  value !== null &&
  ((value as { type?: unknown }).type === 'den-library-suspend' ||
    (value as { type?: unknown }).type === 'den-library-resume') &&
  (value as { protocol?: unknown }).protocol === LIBRARY_SHARED_WORKER_PROTOCOL;
