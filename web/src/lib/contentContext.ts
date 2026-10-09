import { getContext, setContext } from 'svelte';
import type { ContentServiceClientPort } from './libraryServiceFactory';

const CONTENT_SERVICE = Symbol('content service');

/** Make the session's semantic content port available to deeply nested cards without provider-shaped props. */
export function setContentServiceContext(content: ContentServiceClientPort): void {
  setContext(CONTENT_SERVICE, content);
}

/** Isolated presentation fixtures may omit content; production route trees always provide it. */
export function contentServiceContext(): ContentServiceClientPort | undefined {
  return getContext(CONTENT_SERVICE);
}
