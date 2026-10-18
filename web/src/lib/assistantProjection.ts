// Where the library Worker has an assistant projection built (den-spec wire/assistant-v1.md §15): in a Worker of its
// own, started for the build and ended after it, so the library Worker answers the page throughout. Builds come at
// most every 30 s, after a change or at the 15-minute heartbeat, so nothing is kept between them.
import { assistantAnswer, assistantModule, ensureAssistantPolicy } from './assistantCore';

/** What the projection Worker is sent: the compiled assistant module and the op's request, as UTF-8 (transferred). */
export interface ProjectionBuild {
  module: WebAssembly.Module;
  request: ArrayBuffer;
}

/** What it answers: den-core's answer as written, or why it could not be had. */
export type ProjectionBuilt = { answer: string } | { error: string };

/**
 * den-core's answer to an `assistant_projection` request. In this thread only where no Worker can be started, or the
 * module could not be compiled to hand over.
 */
export async function buildProjection(request: string): Promise<string> {
  await ensureAssistantPolicy();
  const module = assistantModule();
  if (!module || typeof Worker === 'undefined') return assistantAnswer(request);
  let worker: Worker;
  try {
    worker = new Worker(new URL('./assistantProjectionWorker.ts', import.meta.url), {
      type: 'module',
    });
  } catch (error) {
    console.warn('den: no Worker could be started for the assistant projection', error);
    return assistantAnswer(request);
  }
  try {
    return await new Promise<string>((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<ProjectionBuilt>) =>
        'answer' in data ? resolve(data.answer) : reject(new Error(data.error));
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error(`the projection Worker failed: ${event.message}`));
      };
      const bytes = new TextEncoder().encode(request).buffer;
      worker.postMessage({ module, request: bytes } satisfies ProjectionBuild, [bytes]);
    });
  } finally {
    worker.terminate();
  }
}
