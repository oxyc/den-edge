import type { ContentServiceTransport } from './contentServiceClient';
import type { LibraryServiceTransport } from './libraryServiceClient';
import type { ContentServiceClientMessage } from './contentServiceProtocol';
import type { LibraryServiceClientMessage } from './libraryServiceProtocol';

export type ServiceClientMessage = LibraryServiceClientMessage | ContentServiceClientMessage;

/** The two logical services carried by one physical runtime connection. */
export interface LibraryServiceMultiplexTransport extends LibraryServiceTransport {
  send(message: ServiceClientMessage): void;
  contentTransport(): ContentServiceTransport;
}
