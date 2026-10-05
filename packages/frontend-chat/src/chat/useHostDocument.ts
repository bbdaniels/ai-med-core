// The host page's current document, for a followHost project inside a frame
// (see ../host-document.ts for the messages and the checks they pass). The
// talk page uses it; nothing else does, and without followHost it never
// listens and never posts.

import { useEffect, useRef, useState } from 'react';
import { type HostDocument, listenForHostDocument, postTalkReady } from '../host-document';

export interface HostDocumentOptions {
  /** followHost and framed (useDeepLink's hostDriven). */
  enabled: boolean;
  embedOrigins: readonly string[];
  /** Access is settled and the document list has loaded: the page can take a document. */
  ready: boolean;
}

export function useHostDocument({ enabled, embedOrigins, ready }: HostDocumentOptions) {
  // The host's latest word; null until it has said anything.
  const [hostDocument, setHostDocument] = useState<HostDocument | null>(null);
  const origins = embedOrigins.join(' ');

  useEffect(() => {
    if (!enabled) return undefined;
    return listenForHostDocument(window, { followHost: true, embedOrigins: origins.split(' ').filter(Boolean) }, setHostDocument);
  }, [enabled, origins]);

  // Once per page load: the host answers with the current document.
  const announced = useRef(false);
  useEffect(() => {
    if (!enabled || !ready || announced.current) return;
    announced.current = postTalkReady(window);
  }, [enabled, ready]);

  return { hostDocument };
}
