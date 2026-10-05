// Escape closes an embedded chat, wherever focus is inside it.
//
// A framed page (the deck's Ask popover, the publications popout) owns every
// key pressed while focus is inside it, so the host page never sees an Escape
// typed into the chat's text box. The page therefore posts the same close
// message its header's Close control posts (useDeepLink's closeEmbeddingFrame).
//
// One listener, on the window, for the whole page. It runs after every
// document-level and React handler, so an Escape that something else already
// consumed (an open menu's useDismiss, a find box clearing its query) has
// defaultPrevented set and is left alone. An Escape that ends an IME
// composition (isComposing, or Safari's keyCode 229) is the input method's,
// never the page's.

export interface EscapeKeyLike {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented: boolean;
}

/** Whether this keydown should close the embedding frame. */
export function closesFrame(e: EscapeKeyLike): boolean {
  return e.key === 'Escape' && !e.defaultPrevented && !e.isComposing && e.keyCode !== 229;
}

/** Listen for an Escape that closes the frame; returns the teardown. */
export function listenForFrameEscape(target: EventTarget, close: () => void): () => void {
  const onKey = (event: Event) => {
    if (closesFrame(event as unknown as EscapeKeyLike)) close();
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}
