import type { ProjectionBuild, ProjectionBuilt } from './assistantProjection';

/** Run one projection build off the library Worker. Kept behind a lazy boundary so reduced Tizen never packages it. */
export async function buildProjectionInWorker(request: string): Promise<string> {
  const worker = new Worker(new URL('./assistantProjectionWorker.ts', import.meta.url), {
    type: 'module',
  });
  try {
    return await new Promise<string>((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<ProjectionBuilt>) =>
        'answer' in data ? resolve(data.answer) : reject(new Error(data.error));
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error(`the projection Worker failed: ${event.message}`));
      };
      const bytes = new TextEncoder().encode(request).buffer;
      worker.postMessage({ request: bytes } satisfies ProjectionBuild, [bytes]);
    });
  } finally {
    worker.terminate();
  }
}
