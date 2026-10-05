// The course access gate (project.json requireAccessCode).
//
// `unlocked` starts true when a token is already held, so a returning student
// never sees the gate. A code supplied in the URL fragment (#code=) is redeemed
// before the gate is ever shown, and the fragment is scrubbed either way.

import { useEffect, useState } from 'react';
import { api, apiFetch, getAccessToken, readAccessCodeFromUrl, scrubAccessCodeFromUrl, setAccessToken } from '../api-base';

export function useAccessGate(configLoaded: boolean, requireAccessCode: boolean) {
  const [unlocked, setUnlocked] = useState<boolean>(() => !!getAccessToken());
  // Held in state rather than read on each render, because the redemption
  // effect scrubs the fragment and a re-read after that would find nothing.
  const [urlAccessCode, setUrlAccessCode] = useState<string | null>(() => readAccessCodeFromUrl());
  const [redeemingUrlCode, setRedeemingUrlCode] = useState<boolean>(() => !!urlAccessCode);

  // Changing only the fragment is a same-document navigation: the SPA does not
  // reload and nothing remounts. A student already on the page who follows a
  // coded Canvas link would otherwise never have it redeemed.
  useEffect(() => {
    const onHashChange = () => {
      const code = readAccessCodeFromUrl();
      if (!code) return;
      setUrlAccessCode(code);
      setRedeemingUrlCode(true);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Redeem a URL-supplied access code. Runs before the gate can render, and
  // scrubs the fragment either way — a code left in the address bar is
  // shoulder-surfable and would be re-submitted on every reload.
  //
  // It runs even when a token is already held, which is the point: in a
  // third-party iframe Safari may have dropped the stored token since the last
  // visit, and re-redeeming costs one request and always leaves us with a fresh
  // one.
  useEffect(() => {
    if (!configLoaded) return;
    if (!urlAccessCode) return;
    if (!requireAccessCode) {
      // Nothing to redeem it against; still take it out of the address bar.
      scrubAccessCodeFromUrl();
      setRedeemingUrlCode(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(api('/api/access'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: urlAccessCode }),
        });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && data?.token) {
          setAccessToken(data.token);
          setUnlocked(true);
        }
      } catch {
        /* fall through to the manual gate */
      } finally {
        scrubAccessCodeFromUrl();
        if (!cancelled) setRedeemingUrlCode(false);
      }
    })();
    return () => { cancelled = true; };
  }, [configLoaded, requireAccessCode, urlAccessCode]);

  return {
    unlocked,
    /** Called by the gate once the reader's code has been accepted. */
    unlock: () => setUnlocked(true),
    // Whether the gated endpoints (/api/tabs, /api/vignettes, /api/project-content)
    // will answer us. Every fetch of one must wait on this. React runs a component's
    // effects even when it early-returns the gate instead of the app, so without
    // this the tab fetch fires behind the gate, takes a 401, and never retries --
    // which is exactly how the form panel ended up rendering for a formless project.
    accessReady: configLoaded && (!requireAccessCode || unlocked),
    // Show the gate. It waits for /api/config: gating on a flag we have not
    // loaded yet would flash the gate at every visitor of every ungated project.
    gateShown: configLoaded && requireAccessCode && !unlocked && !redeemingUrlCode,
  };
}
