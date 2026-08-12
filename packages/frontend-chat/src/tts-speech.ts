// Pure helpers for the voice-TTS path: split an assistant message into
// per-role speech segments (stripping the "Patient:" / "Nurse:" role-prefix
// markers that the system prompts instruct the model to emit) and resolve
// which OpenAI voice speaks each segment.
//
// Kept free of React/DOM so the logic is unit-testable in plain Node.

export interface TtsSegment {
  /** 'patient' for the default speaker (the simulated patient), 'other' for anyone else (e.g. the nurse). */
  role: 'patient' | 'other';
  /** The literal prefix name that opened this segment (e.g. "Nurse", "Bệnh nhân"), or null for unprefixed patient speech. */
  speaker: string | null;
  /** Segment text with role-prefix markers stripped from every line. */
  text: string;
}

// Role-prefix markers that actually occur in the voice-enabled projects'
// system prompts (projects/{voice→macy_hms,teech,haivn}/system-prompt.md):
// English "Patient:" / "Nurse:", Vietnamese "Bệnh nhân:" / "Y tá:" (haivn).
const PATIENT_ROLES = ['Patient', 'Bệnh nhân'];
const OTHER_ROLES = ['Nurse', 'Y tá'];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split an assistant message into contiguous same-role runs for TTS.
 *
 * - Prefix matching is line-anchored (`^Speaker:`), never a global replace,
 *   so a colon inside dialogue ("I told him: no") is untouched.
 * - Recognized speakers are the known role markers above plus any keys of the
 *   vignette's `speakerVoices` config (so configured speakers are honored
 *   even if not in the hardcoded list).
 * - Text before any prefix belongs to the patient (the default speaker).
 * - Consecutive lines with the same role merge into ONE segment (per
 *   contiguous role run, not per line); the prefix is stripped from each line.
 * - A message with no prefixes yields exactly one patient segment with the
 *   text unchanged, so single-role behavior is one TTS request, as before.
 */
export function splitRoleSegments(message: string, extraSpeakers: string[] = []): TtsSegment[] {
  const speakers = [...new Set([...PATIENT_ROLES, ...OTHER_ROLES, ...extraSpeakers])];
  const prefixRe = new RegExp(`^\\s*(${speakers.map(escapeRegExp).join('|')})\\s*:\\s*`);

  const segments: TtsSegment[] = [];
  let current: TtsSegment | null = null;

  for (const line of message.split('\n')) {
    const m = line.match(prefixRe);
    if (m) {
      const speaker = m[1];
      const role: TtsSegment['role'] = PATIENT_ROLES.includes(speaker) ? 'patient' : 'other';
      const text = line.slice(m[0].length);
      if (current && current.role === role) {
        // Same role continues (e.g. two "Patient:" lines in a row): same segment.
        current.text += '\n' + text;
        // Adopt the explicit speaker if the run began unprefixed (or blank),
        // so speakerVoices overrides still apply to the merged segment.
        if (!current.speaker) current.speaker = speaker;
      } else {
        current = { role, speaker, text };
        segments.push(current);
      }
    } else if (current) {
      current.text += '\n' + line;
    } else {
      current = { role: 'patient', speaker: null, text: line };
      segments.push(current);
    }
  }

  // Drop whitespace-only segments (e.g. a blank line before the first prefix)
  // and trim run boundaries so TTS never receives dangling newlines.
  return segments
    .map(seg => ({ ...seg, text: seg.text.trim() }))
    .filter(seg => seg.text.length > 0);
}

/**
 * Voice mapping (Ben's option b): the user-selected dropdown voice — or the
 * vignette-assigned voice — is always the Patient. Any other speaker gets a
 * deterministic contrasting default: onyx, unless the patient voice is
 * already onyx, in which case nova. This keeps the two roles audibly
 * distinct with no per-project configuration.
 */
export function contrastingVoice(patientVoice: string): string {
  return patientVoice === 'onyx' ? 'nova' : 'onyx';
}

/**
 * Resolve the voice for a segment. A vignette's `speakerVoices` config (e.g.
 * `{"Nurse": "shimmer"}`) wins when it names the segment's speaker —
 * preserving existing behavior — otherwise patient segments use the patient
 * voice and any other role falls back to the contrasting default.
 */
export function resolveSegmentVoice(
  segment: TtsSegment,
  patientVoice: string,
  speakerVoices?: Record<string, string>,
): string {
  if (segment.speaker && speakerVoices?.[segment.speaker]) {
    return speakerVoices[segment.speaker];
  }
  return segment.role === 'patient' ? patientVoice : contrastingVoice(patientVoice);
}
