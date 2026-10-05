// Which document the page opens, and how it sits in a host page.
//
// - The link: ?vignette=, ?doc=, or ?paper=<DOI> looked up in the project's
//   talk manifest (talk-paper.ts). With no match on a manifest project, the
//   reader picks from the manifest's papers instead of being dropped silently
//   into whichever paper happens to be first.
// - requireKnownVignette: a link naming no vignette, or one the deployment does
//   not hold, is refused; the first vignette is never opened in its place.
// - talkPublicUrl: opened top-level, the page leaves for the author's public
//   page at once; only the popout iframe stays.
// - Embedded in another site's popout, the header's picker link becomes a Close
//   control that posts `orcid-display:talk-close` to the host page, and Escape
//   anywhere in the page posts the same message (frame-escape.ts).
//
// Every other project opens its first vignette, as it always has, and the
// simulator's case sequence moves on through selectVignette().

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiFetch } from '../api-base';
import { type TalkPaper, publicRedirectUrl, requestedVignette } from '../talk-paper';
import { listenForFrameEscape } from '../frame-escape';
import { UnknownVignetteError, fetchVignettes } from './api';

/** The message a host page listens for to dismiss its popout. */
export const TALK_CLOSE_MESSAGE = 'orcid-display:talk-close';

export interface DeepLinkOptions {
  configLoaded: boolean;
  talkManifestSlug: string | null;
  talkPublicUrl: string;
  requireKnownVignette: boolean;
  /** The gated endpoints will answer (useAccessGate). */
  accessReady: boolean;
  /** Load the vignette list only once the reader has started. */
  active: boolean;
  /** Simulator assignment: list only this participant's vignettes. */
  uid?: string | null;
}

export function useDeepLink(o: DeepLinkOptions) {
  const { configLoaded, talkManifestSlug, talkPublicUrl, requireKnownVignette, accessReady, active } = o;
  const uid = o.uid ?? null;
  const [talkPapers, setTalkPapers] = useState<TalkPaper[]>([]);
  // The vignette the URL asks for: undefined while it is still being resolved
  // (the manifest fetch), null when the URL names none, else the key.
  const [urlVignette, setUrlVignette] = useState<string | null | undefined>(undefined);
  const [vignetteKeys, setVignetteKeys] = useState<string[]>([]);
  const [selectedVignetteKey, setSelectedVignetteKey] = useState<string | null>(null);
  const [currentVignetteIndex, setCurrentVignetteIndex] = useState<number>(0);
  const [vignetteRefused, setVignetteRefused] = useState(false);

  // When the chat is embedded in another site's popout (the orcid-display
  // "Talk to this paper" panel), the header's picker link makes no sense: the
  // reader came for one paper. It becomes a Close control that asks the host
  // page to dismiss the panel; the host listens for exactly this message.
  const embeddedInFrame = useMemo(() => { try { return window.self !== window.top; } catch { return true; } }, []);
  // The public-page redirect is a production rule. A dev server on localhost
  // keeps rendering top-level so the project can be worked on in a plain tab.
  const isLocalDevHost = useMemo(() => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname), []);
  const closeEmbeddingFrame = useCallback(() => {
    try { window.parent.postMessage({ type: TALK_CLOSE_MESSAGE }, '*'); } catch { /* not embedded */ }
  }, []);
  const redirectsToPublicPage = !!talkPublicUrl && !embeddedInFrame && !isLocalDevHost;
  // Framed, Escape anywhere in the page (the chat's text box included) asks
  // the host to close, the same as the header's Close control.
  useEffect(() => (embeddedInFrame ? listenForFrameEscape(window, closeEmbeddingFrame) : undefined),
    [embeddedInFrame, closeEmbeddingFrame]);

  // Resolve the vignette the URL asks for (?vignette=, ?doc=, or ?paper=<DOI>
  // through the talk manifest) before any vignette is chosen. A manifest that fails to load,
  // or is empty because public chat is switched off, just means no ?paper= match.
  useEffect(() => {
    if (!configLoaded) return;
    const search = window.location.search;
    if (!talkManifestSlug) {
      setUrlVignette(requestedVignette(search, []));
      return;
    }
    let cancelled = false;
    apiFetch(api(`/api/talk-manifest/${encodeURIComponent(talkManifestSlug)}`))
      .then(res => (res.ok ? res.json() : { papers: [] }))
      .then(data => {
        if (cancelled) return;
        const papers: TalkPaper[] = Array.isArray(data?.papers)
          ? data.papers.filter((p: TalkPaper) => p && typeof p.vignette === 'string' && typeof p.title === 'string')
          : [];
        // Not framed: leave for the public page before anything past the loading
        // state renders. urlVignette stays undefined, so no vignette loads and the
        // picker never mounts while the browser navigates away.
        if (redirectsToPublicPage) {
          window.location.replace(publicRedirectUrl(talkPublicUrl, search, papers));
          return;
        }
        setTalkPapers(papers);
        setUrlVignette(requestedVignette(search, papers));
      })
      .catch(() => {
        if (cancelled) return;
        if (redirectsToPublicPage) {
          window.location.replace(publicRedirectUrl(talkPublicUrl, search, []));
          return;
        }
        setUrlVignette(requestedVignette(search, []));
      });
    return () => { cancelled = true; };
  }, [configLoaded, talkManifestSlug, talkPublicUrl, redirectsToPublicPage]);

  // Load vignettes only after the reader starts (filtered by uid if present)
  useEffect(() => {
    if (!active || !accessReady || urlVignette === undefined) return;
    if (requireKnownVignette && !urlVignette) {
      setVignetteRefused(true);
      return;
    }
    fetchVignettes(uid, requireKnownVignette ? urlVignette : null)
      .then(keys => {
        setVignetteKeys(keys);
        if (requireKnownVignette) {
          // The server has confirmed it holds the key (else it answered 404).
          const index = urlVignette ? keys.indexOf(urlVignette) : -1;
          if (index < 0) { setVignetteRefused(true); return; }
          setCurrentVignetteIndex(index);
          setSelectedVignetteKey(keys[index]);
        } else if (keys.length > 0) {
          // Selection precedence: the vignette the URL names (?vignette=, or a
          // ?paper= DOI found in the talk manifest); else, on a talkManifest
          // project with papers to offer, nothing yet (the paper picker shows);
          // else the first vignette, as every other project always has.
          const requested = urlVignette ? keys.indexOf(urlVignette) : -1;
          const offersPicker = !!talkManifestSlug && talkPapers.some(p => keys.includes(p.vignette));
          if (requested >= 0) {
            setCurrentVignetteIndex(requested);
            setSelectedVignetteKey(keys[requested]);
          } else if (!offersPicker) {
            setCurrentVignetteIndex(0);
            setSelectedVignetteKey(keys[0]);
          }
        }
        console.log('Vignette keys loaded successfully', uid ? `for uid: ${uid}` : '(all vignettes)');
      })
      .catch(error => {
        if (error instanceof UnknownVignetteError) { setVignetteRefused(true); return; }
        console.error('Error loading vignette keys:', error);
      });
  }, [active, uid, accessReady, urlVignette, talkManifestSlug, talkPapers, requireKnownVignette]);

  // The talk-manifest paper currently open, and the papers the picker offers
  // (only those whose vignette the deployment actually serves).
  const selectedPaper = useMemo(
    () => (talkManifestSlug && selectedVignetteKey
      ? talkPapers.find(p => p.vignette === selectedVignetteKey) ?? null : null),
    [talkManifestSlug, talkPapers, selectedVignetteKey]);
  const pickerPapers = useMemo(
    () => (talkManifestSlug ? talkPapers.filter(p => vignetteKeys.includes(p.vignette)) : []),
    [talkManifestSlug, talkPapers, vignetteKeys]);

  const selectVignette = (index: number, key: string | null) => {
    setCurrentVignetteIndex(index);
    setSelectedVignetteKey(key);
  };

  // Open a paper from the picker, or (key = null) go back to the picker, with
  // the address bar updated so the page can be bookmarked or shared as
  // ?paper=<DOI>. Returns false, and changes nothing, for a key the deployment
  // does not serve; the caller starts a fresh conversation on true.
  const openPaper = (key: string | null): boolean => {
    const index = key ? vignetteKeys.indexOf(key) : -1;
    if (key && index < 0) return false;
    selectVignette(Math.max(0, index), key);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('vignette');
      url.searchParams.delete('doc');
      const doi = key ? talkPapers.find(p => p.vignette === key)?.doi : null;
      if (doi) url.searchParams.set('paper', doi);
      else url.searchParams.delete('paper');
      window.history.replaceState(null, '', url.toString());
    } catch { /* the address bar is a convenience */ }
    return true;
  };

  return {
    embeddedInFrame, closeEmbeddingFrame,
    /** Render nothing: the page is leaving for the project's public page. */
    leavingForPublicPage: redirectsToPublicPage,
    vignetteKeys, selectedVignetteKey, currentVignetteIndex, vignetteRefused,
    selectedPaper, pickerPapers, selectVignette, openPaper,
  };
}
