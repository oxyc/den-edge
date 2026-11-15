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
  if (__DEN_TV_LEGACY_JS_CORE__ || typeof Worker === 'undefined') {
    await ensureAssistantPolicy();
    return assistantAnswer(request);
  }
  try {
    const { buildProjectionInWorker } = await import('./assistantProjectionWorkerClient');
    return await buildProjectionInWorker(request);
  } catch (error) {
    console.warn('den: no Worker could be started for the assistant projection', error);
    await ensureAssistantPolicy();
    return assistantAnswer(request);
  }
}
