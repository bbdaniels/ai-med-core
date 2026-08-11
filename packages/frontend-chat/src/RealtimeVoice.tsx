import { useState, useRef, useEffect, useCallback } from 'react';
import { api, apiFetch } from './api-base';
import NativeKoboForm from './components/NativeKoboForm';

// Live speech-to-speech voice mode (OpenAI Realtime API), offered as an option
// alongside text chat for projects with `enableRealtime: true`. The browser opens
// a WebRTC connection straight to OpenAI using an ephemeral token minted by
// /api/realtime/session; audio never flows through our backend. After the user
// ends the conversation they fill the same Kobo form as the text flow, and the
// voice transcript is written to the submission — so voice sessions produce the
// same data as text sessions.

type Phase = 'setup' | 'connecting' | 'live' | 'ended' | 'submitted';

interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

interface SessionMint {
  clientSecret: string;
  expiresAt?: number;
  model: string;
  voice: string;
  maxSessionSeconds?: number;
  caseTemplate?: string | null;
}

interface LangDef { code: string; name: string }

const LANG_NAME_FALLBACK: Record<string, string> = {
  en: 'English',
  zh: 'Chinese',
};

function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Mirror App.tsx's URL parsing so voice-mode form prefills match the text flow.
function readPrefillParams(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const valuesList = params.getAll('values').map(v => v.trim()).filter(Boolean);
    if (valuesList.length === 0) return null;
    const joined = valuesList.join('&').replace(/^&+/, '');
    return joined.length > 0 ? joined : null;
  } catch {
    return null;
  }
}

function readUid(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const valuesList = params.getAll('values').map(v => v.trim()).filter(Boolean);
    for (const value of valuesList) {
      const match = value.match(/d\[uid\]=([^&]*)/);
      if (match && match[1]) return decodeURIComponent(match[1]);
    }
    return null;
  } catch {
    return null;
  }
}

// Return to the text chat, preserving any ?values= (uid/prefill) params.
function backToText() {
  const url = new URL(window.location.href);
  url.searchParams.delete('mode');
  window.location.href = url.toString();
}

function serializeTranscript(entries: TranscriptEntry[], vignetteKey: string | null): string {
  const header = [
    'Transcript (Realtime voice)',
    `Created: ${new Date().toISOString()}`,
    vignetteKey ? `Vignette: ${vignetteKey}` : '',
    '',
  ].filter(Boolean).join('\n');
  const body = entries
    .map(e => `${e.role === 'user' ? 'User' : 'Assistant'}:\n${e.text}`)
    .join('\n\n');
  return header + '\n' + body + '\n';
}

function fmtClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export default function RealtimeVoice() {
  const [phase, setPhase] = useState<Phase>('setup');
  const [vignetteKeys, setVignetteKeys] = useState<string[]>([]);
  const [vignetteTitles, setVignetteTitles] = useState<Record<string, string>>({});
  const [selectedVignetteKey, setSelectedVignetteKey] = useState<string | null>(null);
  const [languages, setLanguages] = useState<LangDef[]>([]);
  const [selectedLangCode, setSelectedLangCode] = useState<string>('en');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [caseTemplate, setCaseTemplate] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [token] = useState<string>(() => generateToken());

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const userPrefillParams = useRef<string | null>(readPrefillParams()).current;
  const userUid = useRef<string | null>(readUid()).current;

  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  useEffect(() => { transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [transcript]);

  // Load the same vignettes + languages the text chat offers for this project.
  useEffect(() => {
    apiFetch(api('/api/vignettes'))
      .then(r => r.json())
      .then((data: { vignetteKeys?: string[]; vignettes?: Array<{ key: string; title: string | null }> }) => {
        setVignetteKeys(data.vignetteKeys || []);
        if (Array.isArray(data.vignettes)) {
          const titles: Record<string, string> = {};
          for (const v of data.vignettes) if (v.title) titles[v.key] = v.title;
          setVignetteTitles(titles);
        }
        if (data.vignetteKeys && data.vignetteKeys.length > 0) {
          setSelectedVignetteKey(data.vignetteKeys[0]);
        }
      })
      .catch(err => console.error('Failed to load vignettes:', err));
    apiFetch(api('/api/config'))
      .then(r => r.json())
      .then((data: { languages?: LangDef[] }) => {
        const langs = Array.isArray(data.languages) ? data.languages : [];
        if (langs.length > 0) {
          setLanguages(langs);
          const preferred = langs.find(l => l.code === 'en') || langs[0];
          setSelectedLangCode(preferred.code);
        }
      })
      .catch(err => console.error('Failed to load languages:', err));
  }, []);

  const persistTranscript = useCallback(async (entries: TranscriptEntry[]) => {
    if (entries.length === 0) return;
    try {
      const content = serializeTranscript(entries, selectedVignetteKey);
      await apiFetch(api(`/api/transcripts/${token}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
    } catch (err) {
      console.error('Failed to persist transcript:', err);
    }
  }, [token, selectedVignetteKey]);

  const appendTranscript = useCallback((role: 'user' | 'assistant', text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setTranscript(prev => {
      const next = [...prev, { role, text: trimmed, ts: Date.now() }];
      void persistTranscript(next);
      return next;
    });
  }, [persistTranscript]);

  const handleDataChannelMessage = useCallback((ev: MessageEvent) => {
    let msg: unknown;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const data = msg as { type?: string; transcript?: string; [k: string]: unknown };
    if (data.type) console.debug('[realtime]', data.type);
    switch (data.type) {
      // Session is fully initialized — kick off the first turn so the patient
      // introduces themselves. CRITICAL: do NOT pass `instructions` here; that
      // field REPLACES the session's baked-in instructions (system prompt +
      // vignette + language pin), producing a random fabricated patient. The
      // baked-in prompt already says to introduce as the patient, so a bare
      // response.create is enough. dc.onopen is too early (server hasn't loaded
      // instructions yet) — only session.created is safe.
      case 'session.created': {
        const dc = dcRef.current;
        if (!dc) break;
        try {
          dc.send(JSON.stringify({ type: 'response.create', response: { output_modalities: ['audio'] } }));
        } catch (err) {
          console.error('Failed to send initial response.create:', err);
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const t = typeof data.transcript === 'string' ? data.transcript : '';
        if (t) appendTranscript('user', t);
        break;
      }
      // Accept both the new event name and the older alias — some API surfaces
      // still emit the old one.
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        const t = typeof data.transcript === 'string' ? data.transcript : '';
        if (t) appendTranscript('assistant', t);
        break;
      }
      case 'error': {
        console.error('Realtime error event:', data);
        setSessionError(`Voice error: ${(data.error as { message?: string })?.message || 'unknown'}`);
        break;
      }
    }
  }, [appendTranscript]);

  const cleanupConnection = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try { dcRef.current?.close(); } catch { /* ignore */ }
    try { pcRef.current?.close(); } catch { /* ignore */ }
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    dcRef.current = null;
    pcRef.current = null;
    localStreamRef.current = null;
    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current = null;
    }
  }, []);

  const endConversation = useCallback(() => {
    cleanupConnection();
    setSecondsLeft(null);
    // Final flush in case the last turn arrived as the user hung up.
    void persistTranscript(transcriptRef.current);
    setPhase('ended');
  }, [cleanupConnection, persistTranscript]);

  // Auto-disconnect cost cap: count down from maxSessionSeconds once live.
  const startSessionTimer = useCallback((maxSeconds: number) => {
    if (timerRef.current) clearInterval(timerRef.current);
    const deadline = Date.now() + maxSeconds * 1000;
    setSecondsLeft(maxSeconds);
    timerRef.current = setInterval(() => {
      const left = Math.round((deadline - Date.now()) / 1000);
      setSecondsLeft(left);
      if (left <= 0) endConversation();
    }, 1000);
  }, [endConversation]);

  const startConversation = async () => {
    setSessionError(null);
    setPhase('connecting');
    try {
      const langName =
        languages.find(l => l.code === selectedLangCode)?.name
        || LANG_NAME_FALLBACK[selectedLangCode]
        || 'English';

      // 1. Mint an ephemeral session token (no passphrase — gated server-side by
      //    the project's enableRealtime flag + rate limit).
      const mintResp = await apiFetch(api('/api/realtime/session'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vignetteKey: selectedVignetteKey, language: langName }),
      });
      if (!mintResp.ok) {
        const body = await mintResp.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `Session start failed (${mintResp.status})`);
      }
      const mint = await mintResp.json() as SessionMint;
      setCaseTemplate(mint.caseTemplate ?? null);

      // 2. Build the WebRTC peer connection.
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audioEl = new Audio();
      audioEl.autoplay = true;
      audioElRef.current = audioEl;
      pc.ontrack = (ev) => { if (ev.streams[0]) audioEl.srcObject = ev.streams[0]; };

      // Local mic (prompts for permission).
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;
      dc.onmessage = handleDataChannelMessage;

      // 3. SDP exchange directly with OpenAI using the ephemeral secret as Bearer.
      //    Model is baked into the token at mint time.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpResp = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${mint.clientSecret}`, 'Content-Type': 'application/sdp' },
        body: offer.sdp,
      });
      if (!sdpResp.ok) {
        const text = await sdpResp.text().catch(() => '');
        throw new Error(`OpenAI connection failed (${sdpResp.status}): ${text}`);
      }
      const answerSdp = await sdpResp.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      startSessionTimer(mint.maxSessionSeconds && mint.maxSessionSeconds > 0 ? mint.maxSessionSeconds : 600);
      setPhase('live');
    } catch (err) {
      console.error('Failed to start conversation:', err);
      const isMic = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'NotFoundError');
      setSessionError(isMic
        ? 'Microphone access is required for voice mode. Please allow the microphone and try again.'
        : (err instanceof Error ? err.message : 'Failed to start conversation'));
      cleanupConnection();
      setPhase('setup');
    }
  };

  // Clean up on unmount.
  useEffect(() => () => cleanupConnection(), [cleanupConnection]);

  const handleFormSubmitted = async () => {
    try {
      const entries = transcriptRef.current;
      if (entries.length > 0) {
        const fullTranscript = serializeTranscript(entries, selectedVignetteKey);
        await apiFetch(api('/api/kobo-transcript'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, transcript: fullTranscript }),
        });
      }
    } catch (err) {
      console.error('Failed to write transcript to Kobo:', err);
    }
    setPhase('submitted');
  };

  // ── Styles (ai-med theme vars) ────────────────────────────────────
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '12px 16px', fontSize: '1rem',
    borderRadius: 8, border: '1px solid var(--border)',
    background: 'var(--bg-input)', color: 'var(--text-body)', marginBottom: '1rem',
  };
  const primaryBtnStyle: React.CSSProperties = {
    width: '100%', padding: '14px 16px', fontSize: '1.05rem',
    borderRadius: 8, border: 'none', cursor: 'pointer',
    background: 'var(--accent)', color: '#fff', fontWeight: 600,
  };
  const backLinkStyle: React.CSSProperties = {
    background: 'none', border: 'none', color: 'var(--text-secondary)',
    cursor: 'pointer', fontSize: '0.9rem', padding: 0, marginBottom: '1rem',
  };

  if (phase === 'setup' || phase === 'connecting') {
    return (
      <div className="welcome-screen">
        <div className="welcome-content" style={{ maxWidth: 560, textAlign: 'left' }}>
          <button onClick={backToText} style={backLinkStyle}>&larr; Back to text chat</button>
          <h1>Voice conversation</h1>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
            Talk through the case out loud with the digital standardized patient (DSP). When you click Start,
            your browser will ask for microphone permission. End the conversation when you are
            done, then complete the assessment form.
          </p>
          {languages.length > 1 && (
            <div style={{ marginBottom: '1.25rem' }}>
              <label htmlFor="rt-lang" style={{ display: 'block', marginBottom: 6, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                Language
              </label>
              <select
                id="rt-lang"
                value={selectedLangCode}
                onChange={e => setSelectedLangCode(e.target.value)}
                style={{ ...inputStyle, marginBottom: 0, appearance: 'auto' }}
              >
                {languages.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select>
            </div>
          )}
          {vignetteKeys.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>Loading scenarios…</p>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: '1.5rem' }}>
                {vignetteKeys.map(k => (
                  <label key={k} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 8,
                    border: `1px solid ${selectedVignetteKey === k ? 'var(--accent)' : 'var(--border)'}`,
                    background: selectedVignetteKey === k ? 'var(--bg-card)' : 'var(--bg-surface)',
                    color: 'var(--text-body)', cursor: 'pointer',
                  }}>
                    <input type="radio" name="vignette" checked={selectedVignetteKey === k} onChange={() => setSelectedVignetteKey(k)} />
                    {vignetteTitles[k]
                      ? <span style={{ fontSize: '0.95rem' }}>{vignetteTitles[k]}</span>
                      : <span style={{ fontFamily: 'monospace', fontSize: '0.9rem' }}>{k}</span>}
                  </label>
                ))}
              </div>
              {sessionError && <p style={{ color: 'var(--error)', marginBottom: '1rem' }}>{sessionError}</p>}
              <button onClick={startConversation} disabled={!selectedVignetteKey || phase === 'connecting'} style={primaryBtnStyle}>
                {phase === 'connecting' ? 'Connecting…' : 'Start conversation'}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // Live / ended / submitted — split panel matching the main app.
  const leftMobileHidden = phase === 'ended' || phase === 'submitted';
  const rightMobileHidden = phase === 'live';
  const lowTime = secondsLeft !== null && secondsLeft <= 60;
  return (
    <div className="main-container">
      <div className={`left-panel ${leftMobileHidden ? 'mobile-hidden' : ''}`}>
        <div className="left-panel-inner">
          <div className="left-panel-content">
            <div className="conversation-display">
              <div className="chat-header-scrollable">
                <div className="vignette-info">
                  <h1>Voice conversation</h1>
                  <p>
                    {phase === 'live' && 'Listening — speak naturally. Click End when finished.'}
                    {phase === 'ended' && 'Conversation ended. Complete the form on the right to save.'}
                    {phase === 'submitted' && 'Submitted. Thank you.'}
                  </p>
                </div>
                {phase === 'live' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <button
                      onClick={endConversation}
                      style={{ padding: '8px 14px', borderRadius: 6, border: 'none', background: 'var(--error)', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
                    >
                      End conversation
                    </button>
                    <span style={{ color: 'var(--accent)', fontWeight: 600, fontSize: '0.9rem' }}>● Live</span>
                    {secondsLeft !== null && (
                      <span style={{ color: lowTime ? 'var(--error)' : 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', fontSize: '0.9rem' }}>
                        {fmtClock(secondsLeft)} left
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="messages-container">
                {transcript.length === 0 && phase === 'live' && (
                  <div className="message bot-message">
                    <div className="message-content" style={{ fontStyle: 'italic', opacity: 0.6 }}>Waiting for the first turn…</div>
                  </div>
                )}
                {transcript.map((entry, i) => (
                  <div key={i} className={`message ${entry.role === 'user' ? 'user-message' : 'bot-message'}`}>
                    <div className="message-content">{entry.text}</div>
                  </div>
                ))}
                <div ref={transcriptEndRef} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={`right-panel ${rightMobileHidden ? 'mobile-hidden' : ''}`}>
        {phase === 'submitted' ? (
          <div className="post-submission-wrapper">
            <div className="post-submission-content">
              <h2>Thank you</h2>
              <p>Your voice transcript has been saved with your form submission.</p>
              <button onClick={backToText}>Back to start</button>
            </div>
          </div>
        ) : phase === 'ended' ? (
          selectedVignetteKey ? (
            <NativeKoboForm
              transcriptToken={token}
              vignetteId={selectedVignetteKey}
              caseTemplate={caseTemplate}
              language={selectedLangCode}
              userPrefillParams={userPrefillParams}
              userUid={userUid}
              submitLabel="Submit"
              submittingLabel="Submitting..."
              loadingLabel="Loading form..."
              onSubmitted={handleFormSubmitted}
            />
          ) : (
            <div className="loading-form-wrapper"><p>Loading form…</p></div>
          )
        ) : (
          <div className="loading-form-wrapper">
            <p>The assessment form will appear here once you end the conversation.</p>
          </div>
        )}
      </div>
    </div>
  );
}
