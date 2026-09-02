#!/usr/bin/env node
/**
 * Probe the haivn_eip advisor on the facility-classification rule.
 *
 * Vietnam replaced the hospital-grade / administrative-line scheme (hạng I/II/III,
 * tuyến trung ương/tỉnh/huyện) with three levels of professional and technical
 * expertise (cấp ban đầu / cấp cơ bản / cấp chuyên sâu) from 01/01/2025, and
 * hepatitis C services are no longer limited to hạng II and above. This script
 * asks the advisor old-scheme-framed and new-scheme-framed questions in English
 * and Vietnamese, prints each answer verbatim, and checks it.
 *
 * The check is deliberately narrow, because it is the regression that matters:
 * an answer that reports a hospital-grade or administrative-line restriction
 * must also say that scheme was replaced, and every answer must name the
 * current framework. "9 of 9 pass" read off free text by a human is not a test,
 * and this rule is the part a human was reading for. Exit code is 1 if any
 * probe fails, so a run can gate a change.
 *
 * Usage:
 *   node tools/probe-facility-levels.mjs                       # local dev API
 *   node tools/probe-facility-levels.mjs https://api.ai-med.live
 *
 * NOTE: a run against production tests the prompt CI last pushed, not the
 * working tree. Only a local run tests an uncommitted system-prompt.md.
 */

const BASE = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');
const PROJECT = 'haivn_eip';
const VIGNETTE = 'eip_advisor';

const PROBES = [
  { id: 1, framing: 'old',  lang: 'English',    q: 'Is hepatitis C treatment restricted to level II hospitals and above? Our hospital is level III.' },
  { id: 2, framing: 'old',  lang: 'English',    q: 'We are a district-level health centre, not a level I or level II hospital. Are we allowed to provide HCV treatment paid by health insurance?' },
  { id: 3, framing: 'old',  lang: 'Vietnamese', q: 'Bệnh viện hạng II có được điều trị viêm gan C và được BHYT thanh toán không? Bệnh viện hạng III thì sao?' },
  { id: 4, framing: 'old',  lang: 'Vietnamese', q: 'Trung tâm y tế tuyến huyện của chúng tôi có được cung cấp dịch vụ điều trị viêm gan C không?' },
  { id: 5, framing: 'new',  lang: 'English',    q: 'How are health facilities classified now, and which levels can provide hepatitis C treatment?' },
  { id: 6, framing: 'new',  lang: 'Vietnamese', q: 'Cơ sở khám bệnh, chữa bệnh cấp cơ bản có được cung cấp dịch vụ chăm sóc và điều trị viêm gan C không?' },
  { id: 7, framing: 'old (legal text)', lang: 'English', q: 'What does Decision 4531/QĐ-BYT say about which hospitals can be paid by health insurance for hepatitis C treatment?' },
  { id: 8, framing: 'old (legal text)', lang: 'Vietnamese', q: 'Quyết định 4531/QĐ-BYT nói gì về việc bệnh viện nào được bảo hiểm y tế thanh toán cho điều trị viêm gan C?' },
  // The one probe whose correct answer DOES apply a hạng-based rule today:
  // Điều 13 of Circular 01/2025/TT-BYT keeps the hạng II drug-payment
  // conditions for a facility provisionally placed in the basic level, until a
  // circular replacing 20/2022/TT-BYT is issued. So this probe is checked for
  // the transitional instrument instead of for the past tense.
  { id: 9, framing: 'old (transition)', lang: 'Vietnamese', transitional: true, q: 'Cơ sở mới được cấp giấy phép hoạt động và đang tạm xếp cấp cơ bản thì áp dụng quy định thanh toán thuốc theo hạng nào?' },
];

async function ask(probe) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Project': PROJECT },
    body: JSON.stringify({
      messages: [{ role: 'user', content: probe.q }],
      vignetteKey: VIGNETTE,
      language: probe.lang,
      sessionToken: `probe-facility-${Date.now()}-${probe.id}`,
    }),
  });
  const text = await res.text();
  if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 400)}` };
  try {
    const j = JSON.parse(text);
    return { answer: j.message ?? j.answer ?? JSON.stringify(j), beyondScope: j.beyondScope, followups: j.followups };
  } catch {
    return { answer: text };
  }
}

// Wording that says the old scheme is over: the change date, an explicit
// "no longer / not current", or a past-tense framing of the restriction.
const SUPERSEDED = /01\/01\/2025|1 January 2025|January 1, 2025|no longer|not the current|is outdated|đã (được )?thay thế|không còn|trước đây|tại thời điểm|năm 2021|as of 2025|as recorded/i;
// The framework that replaced it, in either language.
const CURRENT = /cấp ban đầu|cấp cơ bản|cấp chuyên sâu|primary,? (and )?basic|basic,? and specialized|specialized level|15\/2023\/QH15|Điều 104/i;
// Old-scheme vocabulary, which an answer may use only alongside SUPERSEDED.
const OLD_SCHEME = /hạng (I|II|III|đặc biệt)\b|level (I|II|III)\b|grade (I|II|III)\b|tuyến (trung ương|tỉnh|huyện|xã)/i;

// The transitional rule itself, which probe 9 must name.
const TRANSITION = /01\/2025\/TT-BYT|Điều 13|tạm xếp|chuyển tiếp/i;

function check(probe, answer) {
  const fails = [];
  if (probe.transitional) {
    if (!TRANSITION.test(answer)) fails.push('does not name the transitional rule');
    return fails;
  }
  if (OLD_SCHEME.test(answer) && !SUPERSEDED.test(answer)) {
    fails.push('states the old scheme with no sign it was replaced');
  }
  if (!CURRENT.test(answer)) {
    fails.push('does not name the current framework');
  }
  return fails;
}

console.log(`Probing ${BASE} (X-Project: ${PROJECT})\n`);
let failed = 0;
for (const p of PROBES) {
  const r = await ask(p);
  console.log('='.repeat(78));
  console.log(`PROBE ${p.id} [${p.framing} / ${p.lang}]`);
  console.log(`Q: ${p.q}`);
  console.log('-'.repeat(78));
  console.log(r.error ? `ERROR: ${r.error}` : r.answer);
  if (r.beyondScope !== undefined) console.log(`\n(beyondScope: ${r.beyondScope})`);
  const fails = r.error ? ['request failed'] : check(p, r.answer);
  if (fails.length) failed += 1;
  console.log(fails.length ? `RESULT: FAIL -- ${fails.join('; ')}` : 'RESULT: PASS');
  console.log();
}
console.log('='.repeat(78));
console.log(`${PROBES.length - failed}/${PROBES.length} probes pass`);
process.exit(failed ? 1 : 0);
