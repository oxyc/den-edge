import { getContext, setContext } from 'svelte';
import type { ContentServiceClientPort } from './libraryServiceFactory';

const CONTENT_SERVICE = Symbol('content service');

/** Make the session's semantic content port available to deeply nested cards without provider-shaped props. */
export function setContentServiceContext(content: ContentServiceClientPort): void {
  setContext(CONTENT_SERVICE, content);
}

/** Every production and fixture route tree provides one semantic content authority. */
export function contentServiceContext(): ContentServiceClientPort {
  const content = getContext<ContentServiceClientPort | undefined>(CONTENT_SERVICE);
  if (!content) throw new Error('content service context is required');
  return content;
}
