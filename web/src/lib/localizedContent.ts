import type { ContentServiceClientPort } from './contentServiceClient';
import type {
  ContentPolicy,
  ContentRequest,
  ContentResultFor,
  ContentServiceStatusValue,
} from './contentServiceProtocol';
import type { InterfaceLanguage } from './interfaceLanguage';

/** Adds the active profile's language at the last page-side boundary, without rebuilding the content service. */
export class LocalizedContent implements ContentServiceClientPort {
  constructor(
    private readonly inner: ContentServiceClientPort,
    private readonly language: () => InterfaceLanguage,
  ) {}

  query<Request extends ContentRequest>(
    request: Request,
    signal?: AbortSignal,
    policy?: ContentPolicy,
    onProgress?: (partial: ContentResultFor<Request>) => void,
  ): Promise<ContentResultFor<Request>> {
    const language = this.language();
    // Keep English byte-for-byte on the established request path. The Worker already treats absence as English,
    // so the default request pays no clone/allocation and sends no additional structured-clone member.
    const localized = language === 'en' ? request : { ...request, interfaceLanguage: language };
    return this.inner.query(localized, signal, policy, onProgress) as Promise<
      ContentResultFor<Request>
    >;
  }

  onStatus(listener: (status: ContentServiceStatusValue) => void): () => void {
    return this.inner.onStatus(listener);
  }
}
