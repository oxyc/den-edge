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
          addEventListener(type: string, listener: (event: PlayerEvent) => void): void;
        };
        start(options?: Record<string, unknown>): void;
      };
    };
    events: {
      EventType: { MEDIA_STATUS: string; ERROR: string; BUFFERING: string; REQUEST_LOAD: string };
    };
    system: { MessageType: { JSON: unknown } };
  };
}

/** The fields of Google's player events this page reports. */
interface PlayerEvent {
  mediaStatus?: {
    playerState?: string;
    idleReason?: string;
    media?: { customData?: unknown };
  };
  detailedErrorCode?: number;
  reason?: string;
  error?: { message?: string; code?: number; shakaErrorCode?: number } | string;
  isBuffering?: boolean;
  requestData?: {
    customData?: unknown;
    media?: {
      customData?: unknown;
      contentType?: string;
      hlsSegmentFormat?: string;
      hlsVideoSegmentFormat?: string;
      streamType?: string;
    };
  };
}

interface ReceiverLoad {
  id: string;
  generation: number;
}

function receiverLoad(value: unknown): ReceiverLoad | undefined {
  const candidate = (value as { denLoad?: unknown } | null)?.denLoad as
    { id?: unknown; generation?: unknown } | undefined;
  return typeof candidate?.id === 'string' && Number.isInteger(candidate.generation)
    ? { id: candidate.id, generation: candidate.generation as number }
    : undefined;
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

/**
 * What the TV's player did, sent to every connected sender, whose console prints it (`[Den receiver]`): the receiver's
 * own console is out of reach on a Chromecast, and a LOAD that never plays says nothing to the sender otherwise.
 */
let activeLoad: ReceiverLoad | undefined;
const ACTIVE_LOAD = Symbol('active receiver load');
function loadFor(event: PlayerEvent): ReceiverLoad | undefined {
  return (
    receiverLoad(event.requestData?.customData) ??
    receiverLoad(event.requestData?.media?.customData) ??
    receiverLoad(event.mediaStatus?.media?.customData)
  );
}

function tellSenders(
  event: string,
  detail: Record<string, unknown>,
  load: ReceiverLoad | undefined | typeof ACTIVE_LOAD,
): void {
  const reportedLoad = load === ACTIVE_LOAD ? activeLoad : load;
  const message = { type: 'den-receiver-event', event, ...reportedLoad, ...detail };
  // `id` is the signed playlist capability. It belongs on Den's private sender/receiver wire for exact ownership,
  // never in a console a viewer may copy into a report.
  const { id: _privateLoadId, ...diagnostic } = message;
  console.info(`[Den receiver] ${JSON.stringify(diagnostic)}`);
  try {
    // No sender id: every sender connected to this receiver hears it.
    context.sendCustomMessage(RECEIVER_NAMESPACE, undefined as unknown as string, message);
  } catch {
    // Before `start`, or with no sender connected, there is nobody to tell.
  }
}

const player = context.getPlayerManager();
const { EventType } = framework.events;
let reportedState: string | undefined;
// Den's idle screen shows while nothing is loaded; Google's player draws loading and playback.
player.addEventListener(EventType.MEDIA_STATUS, (event) => {
  const state = event.mediaStatus?.playerState;
  if (!state) return;
  document.documentElement.dataset.state = state === 'IDLE' ? 'idle' : 'playing';
  if (state === reportedState) return;
  reportedState = state;
  tellSenders(
    'state',
    { state, idleReason: event.mediaStatus?.idleReason ?? null },
    loadFor(event),
  );
});
player.addEventListener(EventType.REQUEST_LOAD, (event) => {
  activeLoad = loadFor(event);
  const media = event.requestData?.media;
  tellSenders(
    'load',
    {
      contentType: media?.contentType ?? null,
      hlsSegmentFormat: media?.hlsSegmentFormat ?? null,
      hlsVideoSegmentFormat: media?.hlsVideoSegmentFormat ?? null,
      streamType: media?.streamType ?? null,
    },
    activeLoad,
  );
});
player.addEventListener(EventType.BUFFERING, (event) =>
  tellSenders('buffering', { buffering: event.isBuffering ?? null }, loadFor(event)),
);
player.addEventListener(EventType.ERROR, (event) =>
  tellSenders(
    'error',
    {
      detailedErrorCode: event.detailedErrorCode ?? null,
      reason: event.reason ?? null,
      error:
        typeof event.error === 'string'
          ? event.error
          : event.error
            ? {
                message: event.error.message ?? null,
                code: event.error.code ?? null,
                shakaErrorCode: event.error.shakaErrorCode ?? null,
              }
            : null,
    },
    loadFor(event),
  ),
);
addEventListener('securitypolicyviolation', (event) =>
  tellSenders(
    'blocked',
    { directive: event.violatedDirective, url: event.blockedURI },
    ACTIVE_LOAD,
  ),
);

context.start({ customNamespaces: { [RECEIVER_NAMESPACE]: framework.system.MessageType.JSON } });
void learn().then((answer) => console.info(`[Den receiver] ${JSON.stringify(answer)}`));
