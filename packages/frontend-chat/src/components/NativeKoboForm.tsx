import { useEffect, useRef, useState, useCallback } from 'react';
import $ from 'jquery';
import { Form } from 'enketo-core';
import { transform } from 'enketo-transformer/web';
import { api, apiFetch } from '../api-base';
import './enketo-form.css';

// Make jQuery global for enketo-core internals
(window as any).jQuery = $;
(window as any).$ = $;

// =====================================================================
// Drag-drop allocation widget
//
// Transforms three select_one fields (task_diagnosis_worker,
// task_coordination_worker, task_communication_worker) into a
// drag-drop UI. The underlying Enketo radio inputs stay in the DOM
// (hidden via .dragdrop-source-hidden) and receive click events to
// keep the form model in sync. Validation, submission, and XML
// generation all continue to work unchanged.
// =====================================================================

const TASK_FIELDS: { field: string; label: string }[] = [
  { field: 'task_diagnosis_worker', label: 'Diagnosis' },
  { field: 'task_coordination_worker', label: 'Coordination' },
  { field: 'task_communication_worker', label: 'Communication' },
];

const WORKERS: { value: string; label: string; sub: string }[] = [
  { value: 'jordan', label: 'Jordan', sub: 'Senior Consultant, 12 yrs' },
  { value: 'casey', label: 'Casey', sub: 'Consultant, 6 yrs' },
  { value: 'morgan', label: 'Morgan', sub: 'Consultant, 8 yrs' },
];

function findSourceFieldset(formEl: HTMLFormElement, fieldName: string): HTMLElement | null {
  // Enketo wraps select_one in <label class="question"> or <fieldset class="question">.
  // Its child radio inputs have name="/path/to/field". We find the first matching input
  // and walk up to the question container.
  const radios = formEl.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  for (const r of Array.from(radios)) {
    const nm = r.getAttribute('name') || r.getAttribute('data-name') || '';
    if (nm.endsWith('/' + fieldName)) {
      // Walk up to the enclosing .question element
      let p: HTMLElement | null = r.parentElement;
      while (p && !p.classList.contains('question')) {
        p = p.parentElement;
      }
      return p;
    }
  }
  return null;
}

function radiosForField(formEl: HTMLFormElement, fieldName: string): HTMLInputElement[] {
  return Array.from(formEl.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter((r) => {
    const nm = r.getAttribute('name') || r.getAttribute('data-name') || '';
    return nm.endsWith('/' + fieldName);
  });
}

function setFieldValue(formEl: HTMLFormElement, form: any, fieldName: string, value: string) {
  const radios = radiosForField(formEl, fieldName);
  if (radios.length === 0) {
    console.warn(`[dragdrop] no radios found for field ${fieldName}`);
    return;
  }
  if (value === '') {
    // Clear: uncheck all and push empty value through enketo's model
    radios.forEach((r) => {
      r.checked = false;
    });
    const xpath = radios[0].getAttribute('name') || radios[0].getAttribute('data-name') || '';
    try {
      // form.model.node(xpath).setVal('') — enketo-core API
      if (form?.model?.node) {
        form.model.node(xpath).setVal('');
      }
    } catch (e) {
      console.warn('[dragdrop] clear via model failed:', e);
    }
    return;
  }
  const target = radios.find((r) => r.value === value);
  if (!target) {
    console.warn(`[dragdrop] no radio for ${fieldName}=${value}`);
    return;
  }
  // Check and dispatch change — enketo listens for change events on inputs
  target.checked = true;
  target.dispatchEvent(new Event('change', { bubbles: true }));
}

function installDragDropWidget(formEl: HTMLFormElement, form: any): void {
  // Find all three source fieldsets; if any are missing, bail out.
  const sources = TASK_FIELDS.map((t) => ({
    ...t,
    source: findSourceFieldset(formEl, t.field),
  }));
  if (sources.some((s) => !s.source)) {
    console.warn('[dragdrop] one or more task fieldsets not found; widget not installed');
    return;
  }

  // Hide the source fieldsets visually but keep them in the DOM for validation / submission.
  sources.forEach((s) => s.source!.classList.add('dragdrop-source-hidden'));

  // Build the widget DOM.
  const widget = document.createElement('div');
  widget.className = 'allocation-dragdrop';
  widget.innerHTML = `
    <div class="allocation-dragdrop-instructions">
      Drag each worker onto a task. Drag back to the pool to unassign. Each worker handles exactly one task.
    </div>
    <div class="allocation-pool-row">
      <div class="allocation-pool-label">Available</div>
      <div class="allocation-pool" data-zone="pool"></div>
    </div>
    <div class="allocation-tasks">
      ${TASK_FIELDS.map(
        (t) => `
          <div class="allocation-task" data-task-field="${t.field}">
            <div class="allocation-task-label">${t.label}</div>
            <div class="allocation-task-slot" data-zone="${t.field}"></div>
          </div>
        `
      ).join('')}
    </div>
  `;

  // Insert the widget before the first source fieldset so it appears above them.
  sources[0].source!.parentNode?.insertBefore(widget, sources[0].source!);

  // Populate the pool with draggable worker chips.
  const pool = widget.querySelector('[data-zone="pool"]') as HTMLDivElement;
  WORKERS.forEach((w) => {
    const chip = document.createElement('div');
    chip.className = 'allocation-worker';
    chip.draggable = true;
    chip.dataset.worker = w.value;
    chip.innerHTML = `<div class="allocation-worker-name">${w.label}</div><div class="allocation-worker-sub">${w.sub}</div>`;
    chip.addEventListener('dragstart', (ev) => {
      ev.dataTransfer?.setData('text/plain', w.value);
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', () => {
      chip.classList.remove('dragging');
    });
    pool.appendChild(chip);
  });

  // Drop-zone handling: accept any draggable worker into pool or task slot.
  const zones = Array.from(widget.querySelectorAll<HTMLDivElement>('[data-zone]'));
  zones.forEach((zone) => {
    zone.addEventListener('dragover', (ev) => {
      ev.preventDefault(); // allow drop
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => {
      zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', (ev) => {
      ev.preventDefault();
      zone.classList.remove('drag-over');
      const workerValue = ev.dataTransfer?.getData('text/plain') || '';
      if (!workerValue) return;

      const chip = widget.querySelector<HTMLDivElement>(`.allocation-worker[data-worker="${workerValue}"]`);
      if (!chip) return;

      const zoneKey = zone.dataset.zone!;

      // Find the worker's current zone (its parent zone)
      const currentZoneEl = chip.parentElement;
      const currentZoneKey = currentZoneEl?.getAttribute('data-zone') || '';

      // Case 1: worker dropped onto its current zone — no-op
      if (currentZoneKey === zoneKey) return;

      // Case 2: worker moving from one task slot to another, or from pool to task.
      // If target zone is a task slot that already has a different worker, move
      // that worker back to the pool (swap).
      if (zoneKey !== 'pool') {
        // Task slot: max one chip. Move existing occupant (if any) to pool.
        const existing = zone.querySelector<HTMLDivElement>('.allocation-worker');
        if (existing && existing !== chip) {
          pool.appendChild(existing);
          // Clear the old occupant's underlying field — it's now unassigned
          // (but the pool "unassigned" has no underlying field, so clearing
          //  happens via the task field, which we'll overwrite below anyway).
        }
      }

      // If the worker is leaving a task slot, clear that task field.
      if (currentZoneKey && currentZoneKey !== 'pool' && currentZoneKey !== zoneKey) {
        setFieldValue(formEl, form, currentZoneKey, '');
      }

      // Move the chip into the target zone
      zone.appendChild(chip);

      // If dropped onto a task slot, set the underlying field to this worker
      if (zoneKey !== 'pool') {
        setFieldValue(formEl, form, zoneKey, workerValue);
      }
    });
  });
}
// =====================================================================

interface NativeKoboFormProps {
  transcriptToken: string;
  vignetteId: string;
  caseTemplate: string | null;
  language: string;
  userPrefillParams: string | null;
  userUid: string | null;
  submitLabel?: string;
  submittingLabel?: string;
  loadingLabel?: string;
  formTitle?: string;
  dragDropAllocation?: boolean;
  onSubmitted: () => void;
}

export default function NativeKoboForm({
  transcriptToken,
  vignetteId,
  caseTemplate,
  language,
  userPrefillParams,
  userUid,
  submitLabel = 'Submit',
  submittingLabel = 'Submitting...',
  loadingLabel = 'Loading form...',
  formTitle,
  dragDropAllocation = false,
  onSubmitted,
}: NativeKoboFormProps) {
  // Separate ref for the enketo container — React won't touch its children
  const enketoRef = useRef<HTMLDivElement>(null);
  const formInstanceRef = useRef<any>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  // Stable ref for onSubmitted to avoid re-running effect
  const onSubmittedRef = useRef(onSubmitted);
  onSubmittedRef.current = onSubmitted;

  // Use refs for values that change but shouldn't trigger form re-init.
  // transcriptToken changes when formReloadKey changes (token regeneration),
  // but we don't need to rebuild the entire form — just read the latest value
  // at prefill time.
  const transcriptTokenRef = useRef(transcriptToken);
  transcriptTokenRef.current = transcriptToken;

  // Generation counter: prevents stale async initForm from completing
  const initGenRef = useRef(0);

  const initForm = useCallback(async (container: HTMLDivElement) => {
    const gen = ++initGenRef.current;
    console.log(`[Enketo] initForm gen=${gen}, language="${language}"`);

    try {
      setStatus('loading');
      setErrorMsg('');

      // 1. Fetch XForm XML from backend proxy
      const xmlResp = await apiFetch(api('/api/enketo-xform'));
      if (gen !== initGenRef.current) { console.log(`[Enketo] gen=${gen} aborted after fetch`); return; }
      if (!xmlResp.ok) throw new Error('Failed to fetch form definition');
      const xformXml = await xmlResp.text();

      // 2. Transform XForm → HTML + model via browser-native XSLT
      const transformed = await transform({ xform: xformXml });
      if (gen !== initGenRef.current) { console.log(`[Enketo] gen=${gen} aborted after transform`); return; }

      // 3. Inject transformed HTML into the container
      container.innerHTML = `
        <div id="enketo-form-wrapper">
          ${transformed.form}
          <div class="enketo-submit-bar">
            <button type="button" id="enketo-submit-btn" class="enketo-submit-btn">${submitLabel}</button>
          </div>
        </div>
      `;

      const formEl = container.querySelector('form.or') as HTMLFormElement;
      if (!formEl) throw new Error('Transformed HTML missing form element');

      // 4. Prefill values into the model XML
      // Read transcriptToken from ref (latest value, not stale closure)
      let modelStr = transformed.model;
      const prefills: Record<string, string> = {
        transcriptToken: transcriptTokenRef.current,  // Permanent lookup token
        chat_transcript: transcriptTokenRef.current,  // Will be overwritten with full transcript
        vignette_id: vignetteId,
      };
      if (caseTemplate) prefills.case_template = caseTemplate;
      if (userUid) prefills.uid = userUid;

      // Parse additional user prefill params (format: d[key]=value&d[key2]=value2)
      // Filter out reserved fields to prevent URL-based hijacking of transcript/grading linkage
      const reservedFields = new Set(['transcriptToken', 'chat_transcript', 'vignette_id', 'case_template', 'uid']);
      if (userPrefillParams) {
        const params = new URLSearchParams(userPrefillParams);
        for (const [k, v] of params.entries()) {
          const match = k.match(/^d\[(.+)\]$/);
          if (match && !reservedFields.has(match[1])) prefills[match[1]] = v;
        }
      }

      // Inject prefills into the instance data.
      // We modify both the model (so default values are set) and extract the
      // instance as instanceStr (so enketo-core uses it as initial data, not
      // as a blank template that strips prefilled values).
      const parser = new DOMParser();
      const modelDoc = parser.parseFromString(modelStr, 'text/xml');
      for (const [field, value] of Object.entries(prefills)) {
        const el = modelDoc.querySelector(field);
        if (el) {
          el.textContent = value;
        } else {
          console.warn(`[Enketo prefill] field "${field}" not found in model`);
        }
      }
      modelStr = new XMLSerializer().serializeToString(modelDoc);

      // Extract the primary instance element as a standalone XML string
      // for passing as instanceStr to enketo-core
      const instanceEl = modelDoc.querySelector('instance > *');
      const instanceStr = instanceEl
        ? new XMLSerializer().serializeToString(instanceEl)
        : null;

      // 5. Initialize enketo-core Form
      const form = new Form(formEl, {
        modelStr,
        instanceStr,
        submitted: false,
        external: [],
      });

      const loadErrors = form.init();
      if (loadErrors.length > 0) {
        console.warn('Enketo form load warnings:', loadErrors);
      }

      // Abort check after init (synchronous but heavy)
      if (gen !== initGenRef.current) { console.log(`[Enketo] gen=${gen} aborted after init`); return; }

      // 6. Set the form language by directly calling setFormUi() on the
      // language module.  We resolve the short ISO code (e.g. "fr") to
      // the full enketo language name (e.g. "Français (fr)") from the
      // module's known languages list, then call setFormUi() directly
      // rather than dispatching a DOM event (which can silently fail).
      {
        const langModule = (form as any).langs;
        const knownLangs: string[] = langModule?.languages || [];
        let targetLang: string | null = null;

        console.log(`[Enketo] gen=${gen} knownLangs:`, knownLangs, `language prop: "${language}"`);

        if (language && knownLangs.length > 1) {
          targetLang = knownLangs.find((l: string) => {
            // Match exact short code ("fr") or full name with code ("Français (fr)")
            if (l === language) return true;
            const m = l.match(/\((\w+)\)\s*$/);
            return m && m[1] === language;
          }) || null;
        }

        // Fall back to the default / current language if no match
        if (!targetLang) {
          targetLang = langModule?._currentLang || knownLangs[0] || null;
        }

        console.log(`[Enketo] gen=${gen} resolved targetLang: "${targetLang}"`);

        if (targetLang && langModule) {
          langModule._currentLang = targetLang;
          if (langModule.formLanguages) {
            langModule.formLanguages.value = targetLang;
          }
          langModule.setFormUi(targetLang);
          console.log(`[Enketo] gen=${gen} setFormUi("${targetLang}") called`);
        }
      }

      // 7. Handle Kobo's "None" translation artifact.
      // Kobo forms often have a lang="" (None) translation that duplicates
      // English text. enketo-core's setFormUi() always activates [lang=""]
      // alongside the selected language, causing double text. Remove .active
      // from these since all fields have full translations in all languages.
      // BUT: only do this when there are multiple languages — single-language
      // forms use lang="" as the ONLY translation, so removing .active hides
      // all text.
      const knownLangs2: string[] = (form as any).langs?.languages || [];
      if (knownLangs2.length > 1) {
        const noneActive = formEl.querySelectorAll('[lang=""].active');
        console.log(`[Enketo] gen=${gen} removing .active from ${noneActive.length} [lang=""] elements`);
        noneActive.forEach((el) => {
          el.classList.remove('active');
        });
      } else {
        console.log(`[Enketo] gen=${gen} single-language form, keeping [lang=""] elements active`);
      }

      // 7b. Override form title with localized version if provided
      if (formTitle) {
        const titleEl = container.querySelector('#form-title');
        if (titleEl) titleEl.textContent = formTitle;
      }

      formInstanceRef.current = form;

      // 7c. Optional: replace three task select_one fields with a drag-drop widget.
      // The underlying radios stay in the DOM (hidden) so Enketo's model, validation,
      // and submission path are unchanged — the widget just drives them via change events.
      if (dragDropAllocation) {
        try {
          installDragDropWidget(formEl, form);
        } catch (e) {
          console.warn('[Enketo] drag-drop widget install failed:', e);
        }
      }

      // 8. Wire up submit button
      const submitBtn = container.querySelector('#enketo-submit-btn') as HTMLButtonElement | null;
      if (submitBtn) {
        submitBtn.addEventListener('click', async () => {
          if (submitBtn.disabled) return;
          submitBtn.disabled = true;
          submitBtn.textContent = submittingLabel;
          try {
            const valid = await form.validate();
            if (!valid) {
              submitBtn.disabled = false;
              submitBtn.textContent = submitLabel;
              return;
            }

            const xmlInstance = form.getDataStr();

            const resp = await apiFetch(api('/api/enketo-submit'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ xmlInstance }),
            });

            if (!resp.ok) {
              const errData = await resp.json().catch(() => ({}));
              throw new Error(errData.error || 'Submission failed');
            }

            onSubmittedRef.current();
          } catch (err: any) {
            console.error('Form submission error:', err);
            submitBtn.disabled = false;
            submitBtn.textContent = submitLabel;
            alert(err.message || 'Submission failed');
          }
        });
      }

      setStatus('ready');
      console.log(`[Enketo] gen=${gen} form ready`);
    } catch (err: any) {
      if (gen !== initGenRef.current) return; // don't show error for aborted init
      console.error('Form init error:', err);
      container.innerHTML = '';
      setErrorMsg(err.message || 'Failed to load form');
      setStatus('error');
    }
  }, [vignetteId, caseTemplate, language, userPrefillParams, submitLabel, submittingLabel, formTitle, dragDropAllocation]);
  // NOTE: transcriptToken intentionally NOT in deps — read from ref instead

  // Run init once the ref is attached
  useEffect(() => {
    const container = enketoRef.current;
    if (!container) return;

    initForm(container);

    return () => {
      formInstanceRef.current = null;
      if (container) container.innerHTML = '';
    };
  }, [initForm]);

  return (
    <div className="native-kobo-form">
      {status === 'loading' && (
        <div className="enketo-loading">
          <p>{loadingLabel}</p>
        </div>
      )}
      {status === 'error' && (
        <div className="enketo-error">
          <p>Error: {errorMsg}</p>
        </div>
      )}
      {/* This div is never re-rendered by React — enketo owns its contents */}
      <div
        ref={enketoRef}
        style={{ display: status === 'ready' ? 'block' : 'none' }}
      />
    </div>
  );
}
