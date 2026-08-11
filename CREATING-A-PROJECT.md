# Creating a New Project

This guide walks through every step needed to create a new AI-MED project from source materials to live deployment. A "project" is a self-contained unit: clinical cases + assessment form + frontend + deployment config.

> This is a living document. Revise it as the process evolves.

---

## Prerequisites

- The repo cloned and `npm ci` run
- An OpenAI API key (for variant generation)
- Access to KoboToolbox (for form deployment)
- The `ADMIN_PASSPHRASE` secret set in GitHub repo settings (for content push)
- Python 3 with `openpyxl` installed (for Kobo form building)

---

## What You Need to Provide

Before starting, gather these source materials:

| Material | Description | Example |
|----------|-------------|---------|
| **Clinical scenario** | Full case content: patient background, history, exam findings, medications, vitals, SP responses, learning objectives | A Word doc, clinical paper, or structured case write-up |
| **Demographic profiles** | Who the patient variants should be (age, gender, occupation, living situation, etc.) | 2-4 profiles per case template |
| **Assessment questions** | What students fill out after the interview (diagnosis, treatment plan, etc.) | Free-text fields, multiple choice, scales |
| **Grading rubrics** | How transcripts and assessments are scored | Checklist items, scoring categories |
| **Languages** | Which UI languages to support | `["en"]`, `["en", "th"]` |
| **Project name** | A URL-safe slug | `kidney-policy`, `teech-geriatrics` |

---

## Step-by-Step Process

### 1. Create the project directory

```
mkdir -p projects/<name>/cases/<template_name>
mkdir -p projects/<name>/forms
```

If the project uses multiple base case templates, create a subdirectory per template:

```
mkdir -p projects/<name>/cases/<template_1>
mkdir -p projects/<name>/cases/<template_2>
```

### 2. Write project.json

Create `projects/<name>/project.json` following the schema at `projects/project-schema.json`. Start with placeholders for Kobo fields:

```json
{
  "name": "<slug>",
  "displayName": "Human Readable Name",
  "frontend": "chat",
  "cases": {
    "systemPrompt": "projects/<name>/system-prompt.md",
    "vignettes": []
  },
  "kobo": {
    "template": "projects/<name>/forms/diagnosis.json",
    "formUid": null
  },
  "languages": ["en"],
  "deployment": {
    "tablePrefix": "<name>"
  }
}
```

Each vignette entry includes its own `template` field identifying which base case template it belongs to. A project can use multiple templates -- the landing page and eval pipeline group vignettes by template automatically.

### 3. Write the system prompt

Start from the demo prompt and revise to match the case materials:

```
cp projects/demo/system-prompt.md projects/<name>/system-prompt.md
```

The system prompt controls how the LLM behaves during the interview. **Review it carefully against your case materials** -- different cases may need different behavior. Things that commonly vary:

- **Roles**: The demo prompt defines a patient + nurse. Your case may have different roles (e.g., patient + lab tech, patient only, caregiver + patient).
- **Information disclosure**: The demo prompt tells the AI to only answer what's specifically asked and never volunteer details. Some cases may want a more talkative patient.
- **Exam/test handling**: The demo prompt has the nurse provide test results when requested. If your case doesn't include a nurse role or handles exams differently, update this.
- **Opening behavior**: The demo prompt has the patient introduce themselves. Your case may start differently (e.g., the patient is brought in by a family member).
- **Response style**: Plain text only in the demo. Some cases might benefit from structured output for certain roles.

When in doubt, read through a case variant and imagine how the AI should respond to various student questions -- then make sure the system prompt would produce that behavior.

### 4. Set up languages

Copy and adapt the language file:

```
cp projects/demo/languages.json projects/<name>/languages.json
```

The languages file controls **all user-facing text** on the welcome page and chat interface. It must follow this exact structure:

```json
{
  "languages": [
    { "code": "en", "name": "English" }
  ],
  "ui": {
    "en": {
      "welcome": {
        "title": "Project Title",
        "subtitle": "One-line description of what the respondent will do",
        "instructionsLead": "Please read the following instructions before you begin:",
        "howItWorks": "How it works:",
        "bullets": [
          "Bullet 1: what the respondent will do",
          "Bullet 2: who they will interact with",
          "Bullet 3: what role they play",
          "Bullet 4: what they complete afterward",
          "Bullet 5: any reassurances (no time limit, etc.)"
        ],
        "getStarted": "I Agree",
        "languageLabel": "Language"
      },
      "chat": {
        "headerTitle": "Short header above the chat (e.g., 'Patient Interview', 'Community Interaction')",
        "scenarioDescription": "1-2 sentence context shown above the chat explaining the respondent's role and what to do.",
        "inputPlaceholder": "Placeholder in the text input...",
        "send": "Send",
        "loadingForm": "Loading form...",
        "thanksTitle": "Post-submission thank-you message.",
        "nextCase": "Next button text (e.g., 'Next Case', 'Next Scene')",
        "endThankYouMessage": "Final completion message when all vignettes are done.",
        "patientMode": "Mobile tab label for chat side (e.g., 'Patient Mode', 'Scene')",
        "diagnosis": "Mobile tab label for form side (e.g., 'Diagnosis', 'Assessment')"
      }
    }
  }
}
```

**Key points:**
- The `welcome` section populates the landing page (title, instructions, consent, start button).
- The `chat` section populates the chat interface (header, scenario description, placeholders, post-submission text).
- `bullets` is an array of strings rendered as a bullet list under `howItWorks`.
- For multi-language projects, add additional language objects to the `languages` array and corresponding `ui` keys.
- **Customize all text for your project's domain.** Don't leave medical defaults (e.g., "Patient Interview") in a non-medical project.
- **`getStarted`** should always be `"I Agree"` (or its translation) since it follows the informed consent.
- **Informed consent (`consentParagraphs`)**: Every project **must supply its own informed consent text**, approved by the IRB or ethics committee that oversees that project. Do not reuse another project's consent text: it names that study's contact person, institution, and approvals, and it does not cover your study or your participants.

  Write the approved text into `consentParagraphs` in your project's `languages.json`, one array element per paragraph, and provide a faithful translation for each additional language you offer. The consent renders in a scrollable box on the welcome page before the participant can proceed, and the `getStarted` button label should read `"I Agree"` (or its translation) because clicking it is the participant's affirmation.

  The array in `packages/api/defaults/languages.template.json` is a **structural placeholder**, not approved text. If you omit `consentParagraphs` entirely, the frontend falls back to a bracketed placeholder in `App.tsx` that is also not approved text for any study. Either way the brackets will be visible to your participants, which is the intended failure mode: it is meant to be caught before fielding.

  One platform behavior your consent text must cover regardless of wording: the application stores the complete chat transcript and attaches it to the assessment submission. Your consent must disclose that conversations are recorded and retained.

### 5. Create or select base case template(s)

Base case templates live in `cases/<template_name>/` (shared across projects). Each template has:

- **`base.md`** -- the canonical, complete clinical case
- **`meta.json`** -- metadata, clinical invariants, template type

A project can use one or more templates. Repeat steps 5-8 for each base case template the project needs.

If a suitable template already exists (e.g., `cases/fall_elderly/`), skip to step 6 for that template.

To create a new template:

#### 5a. Write base.md

Structure the clinical scenario as markdown following the section format in `cases/fall_elderly/base.md`. Required sections depend on the template type. See `cases/general-diagnosis.md` for a minimal reference.

Key sections typically include:
- Patient Background (name, age, gender, occupation, living situation)
- Chief Complaint & Opening Statement
- History of Present Illness
- Past Medical History
- Medications
- Physical Exam / Vitals
- SP Responses to Provider Questions
- Learning Objectives

#### 5b. Write meta.json

```json
{
  "name": "<template_name>",
  "title": "Case Title That All Variants Share",
  "templateType": "general-diagnosis",
  "description": "Brief clinical description of the scenario.",
  "clinicalInvariants": [
    "Conditions: ...",
    "Core medications: ...",
    "Chief complaint: ...",
    "Clinical findings: ...",
    "Assessment: ...",
    "Management: ..."
  ]
}
```

Clinical invariants are the medical facts that must remain identical across all demographic variants.

### 6. Define demographic profiles

Create `projects/<name>/cases/<template_name>/profiles.json`:

```json
[
  {
    "id": "descriptive-slug",
    "age": 71,
    "gender": "male",
    "occupation": "Retired accountant",
    "livingSituation": "Resides in an assisted living community",
    "maritalStatus": "Widower",
    "familyContact": "Daughter, visits weekly"
  }
]
```

Profiles do NOT include names -- names are derived during variant generation based on gender + project language. See `cases/generation-instructions.md` for the full rules.

### 7. Generate case variants

For each profile, generate a variant by adapting `base.md` to the demographic profile. This is done with an LLM following the rules in `cases/generation-instructions.md`.

Key rules:
- H1 title must match base.md exactly
- Clinical invariants from meta.json must be preserved verbatim
- Provider questions must be preserved verbatim
- Names are freshly derived (never reused from base or other variants)
- SP responses adapt tone/setting but preserve clinical substance

After writing each variant file, register it:

```
npx tsx tools/generate-case.ts register <template> <profile-id> <project> <file-path>
```

This assigns a UUID key, validates the content, updates `variants.json`, and adds the vignette to `project.json`.

### 8. Set up evaluation rubrics

Copy base rubrics to the project and customize:

```
cp cases/<template>/*_rubric.json projects/<name>/cases/<template>/
cp cases/<template>/*_checklist.json projects/<name>/cases/<template>/
```

Each rubric/checklist declares its data source via the `"source"` field:
- `"transcript"` -- grades the chat conversation
- `"field:<name>"` -- grades a specific Kobo form field (e.g., `"field:diagnosis"`)

Edit the project copies to match project-specific evaluation criteria. Add new `*_rubric.json` or `*_checklist.json` files as needed -- the eval pipeline auto-discovers them.

### 9. Build and deploy the Kobo form

#### 9a. Create the form template

Copy and customize the JSON form template:

```
cp kobo/templates/diagnosis.json projects/<name>/forms/diagnosis.json
```

Edit to add project-specific fields, conditional sections, or modified labels. Key conventions:

- **Form title**: The `form_title` in `settings` and the top-level `name` should match the project's `displayName` from `project.json` (e.g., `"CBS: Community-Based Surveillance Training"`).

- **Scene/vignette context notes**: Add a `note` field at the top of each scene or vignette group that briefs the respondent on their role, the setting, who they can talk to, and what actions they can take. This note is the respondent's primary orientation before they begin the chat interaction. Structure each note with bold headings:
  ```json
  {
    "type": "note",
    "name": "s1_context",
    "label": "**Your role:** ...\n\n**Setting:** ...\n\n**What you can do:** ...",
    "relevant": "${vignette_id} = 'scene_1'"
  }
  ```

- **Conditional display with `relevant`**: Use `"relevant": "${vignette_id} = 'scene_N'"` on fields and groups so each vignette shows only its own questions. For multi-template projects, use `${case_template}` instead. The hidden fields `vignette_id` and `case_template` are automatically prefilled by the frontend.

**Multi-template projects**: When a project has multiple base case templates, use `relevant` expressions keyed on `${case_template}` instead of `${vignette_id}`. Add `"relevant": "${case_template} = 'template_name'"` to fields or groups that should only appear for a specific case. This way a single Kobo form serves all cases in the project.

#### 9b. Build the XLSForm

```
python kobo/build_form.py projects/<name>/forms/diagnosis.json
```

This produces `projects/<name>/forms/diagnosis.xlsx`.

#### 9c. Deploy to KoboToolbox

Use the KoboToolbox MCP tools or manual upload:

```
# Via MCP (if available):
mcp__kobotoolbox__deploy_form(file_path="projects/<name>/forms/diagnosis.xlsx")
```

#### 9d. Record the form UID in project.json

After deployment, update `project.json` with the form UID:

```json
"kobo": {
  "template": "projects/<name>/forms/diagnosis.json",
  "formUid": "<uid-from-kobo>"
}
```

Also update `kobo/registry.json` to keep the cross-project registry current.

> **Note:** Anonymous submissions are _not_ needed. The backend proxies form submissions to KoboToolbox using the server-side `KOBO_API_TOKEN`, so respondents never authenticate directly with Kobo.

### 10. Add the GitHub Actions build step

Edit `.github/workflows/deploy-pages.yml` to add a build block for the new project. Duplicate the demo block and change the slug:

```yaml
- name: Build <name> frontend
  run: |
    VITE_API_BASE_URL=$API_BASE_URL \
    VITE_PROJECT=<name> \
    VITE_BASE_PATH=/ai-med/<name>/ \
    npm run build:frontend

    mkdir -p _site/<name>
    cp -r packages/frontend-chat/dist/* _site/<name>/
```

The content push step and eval dashboard copy step already loop over all projects automatically.

### 11. Push to main and verify

```
git add projects/<name>/ .github/workflows/deploy-pages.yml
git commit -m "Add <name> project"
git push
```

On push to main:
- **GitHub Actions** builds the frontend and deploys to GitHub Pages at `https://bbdaniels.github.io/ai-med/<name>/`
- **GitHub Actions** runs `push-content.ts` for each project, pushing vignettes, system prompt, Kobo config, and languages to the Railway backend
- **Railway** auto-deploys the API (if backend code changed)

### 12. Verify the deployment

- [ ] Landing page shows the new project: `https://bbdaniels.github.io/ai-med/`
- [ ] Frontend loads: `https://bbdaniels.github.io/ai-med/<name>/`
- [ ] Chat works (sends messages, gets AI responses)
- [ ] Diagnosis form renders natively in the right panel (not an iframe)
- [ ] Vignettes cycle correctly after form submission
- [ ] Admin panel accessible at `https://bbdaniels.github.io/ai-med/<name>/admin`

---

## Quick Reference: Project File Tree

```
projects/<name>/
├── project.json              # Single source of truth
├── system-prompt.md          # AI behavior instructions (review against case materials!)
├── languages.json            # UI translations
├── cases/
│   ├── <template_1>/        # One directory per base case template
│   │   ├── profiles.json     # Demographic profiles
│   │   ├── variants.json     # UUID-to-profile mapping (auto-generated)
│   │   ├── <uuid>.md         # Generated case variants
│   │   ├── *_rubric.json     # Scoring rubrics (auto-discovered)
│   │   └── *_checklist.json  # Checklists (auto-discovered)
│   └── <template_2>/        # Additional templates if needed
│       └── ...
├── forms/
│   ├── diagnosis.json        # Kobo form template (JSON)
│   └── diagnosis.xlsx        # Built XLSForm (gitignored)
└── eval/                     # Eval results (populated by pipeline)
    ├── index.json
    └── submissions/
```

---

## Reference: The Demo Project

The `projects/demo/` directory is a complete working example. When in doubt, look at how demo does it.
