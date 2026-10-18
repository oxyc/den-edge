// Where the library Worker has an assistant projection built (den-spec wire/assistant-v1.md §15): in a Worker of its
// own, started for the build and ended after it, so the library Worker answers the page throughout. Builds come at
// most every 30 s, after a change or at the 15-minute heartbeat, so nothing is kept between them. The projection Worker
// loads den-core's assistant module itself, as the library Worker does (`assistantCore.ts`): streamed, from WebKit's
// cache of its compiled code, on its own thread.
import { assistantAnswer, ensureAssistantPolicy } from './assistantCore';

/** What the projection Worker is sent: the op's request, as UTF-8 (transferred). */
export interface ProjectionBuild {
  request: ArrayBuffer;
}

/** What it answers: den-core's answer as written, or why it could not be had. */
export type ProjectionBuilt = { answer: string } | { error: string };

/** den-core's answer to an `assistant_projection` request. In this thread only where no Worker can be started. */
export async function buildProjection(request: string): Promise<string> {
  if (typeof Worker === 'undefined') {
    await ensureAssistantPolicy();
    return assistantAnswer(request);
  }
  let worker: Worker;
  try {
    worker = new Worker(new URL('./assistantProjectionWorker.ts', import.meta.url), {
      type: 'module',
    });
  } catch (error) {
    console.warn('den: no Worker could be started for the assistant projection', error);
    await ensureAssistantPolicy();
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
      worker.postMessage({ request: bytes } satisfies ProjectionBuild, [bytes]);
    });
  } finally {
    worker.terminate();
  }
}
