import { RECEIVER_NAMESPACE, type ReceiverReport } from '../../src/lib/castReceiver';
import { receiverReport } from './capabilities';
import './receiver.css';

interface ReceiverGlobals {
  framework: {
    CastReceiverContext: {
      getInstance(): {
        addCustomMessageListener(
          namespace: string,
          listener: (event: { senderId: string; data: unknown }) => void,
        ): void;
        sendCustomMessage(namespace: string, senderId: string, message: unknown): void;
        canDisplayType(type: string): boolean;
        getPlayerManager(): {
          addEventListener(
            type: string,
            listener: (event: { mediaStatus?: { playerState?: string } }) => void,
          ): void;
        };
        start(options?: Record<string, unknown>): void;
      };
    };
    events: { EventType: { MEDIA_STATUS: string } };
    system: { MessageType: { JSON: unknown } };
  };
}

const framework = (window as unknown as { cast?: ReceiverGlobals }).cast?.framework;
if (!framework) throw new Error('the Cast receiver framework did not load');

const context = framework.CastReceiverContext.getInstance();
let report: Promise<ReceiverReport> | undefined;
/** What this TV plays, worked out once, after `start`. */
const learn = () => (report ??= receiverReport((type) => context.canDisplayType(type)));

// The sender asks once its session has started.
context.addCustomMessageListener(RECEIVER_NAMESPACE, (event) => {
  if ((event.data as { type?: unknown } | null)?.type !== 'den-capabilities') return;
  void learn().then((answer) =>
    context.sendCustomMessage(RECEIVER_NAMESPACE, event.senderId, answer),
  );
});

// Den's idle screen shows while nothing is loaded; Google's player draws loading and playback.
context.getPlayerManager().addEventListener(framework.events.EventType.MEDIA_STATUS, (event) => {
  const state = event.mediaStatus?.playerState;
  if (state) document.documentElement.dataset.state = state === 'IDLE' ? 'idle' : 'playing';
});

context.start({ customNamespaces: { [RECEIVER_NAMESPACE]: framework.system.MessageType.JSON } });
void learn().then((answer) => console.info(`[Den receiver] ${JSON.stringify(answer)}`));
