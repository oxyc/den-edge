// One assistant projection build (den-spec wire/assistant-v1.md §15), in a Worker of its own: den-core reads the whole
// library, deflates and seals it, which holds a phone's thread for seconds. The library Worker that starts it hands
// it the compiled assistant module and the request, and keeps answering the page meanwhile.
import { evaluateAssistant, initializeAssistant } from '../vendor/den-core/assistant.js';
import type { ProjectionBuild, ProjectionBuilt } from './assistantProjection';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ProjectionBuild>) => void) | null;
  postMessage(message: ProjectionBuilt): void;
};

scope.onmessage = (event) => {
  void (async () => {
    try {
      await initializeAssistant(event.data.module);
      scope.postMessage({
        answer: evaluateAssistant(new TextDecoder().decode(event.data.request)),
      });
    } catch (error) {
      // The failure's message only: the request carries the read keys.
      scope.postMessage({
        error: error instanceof Error ? error.message : 'the projection could not be built',
      });
    }
  })();
};
