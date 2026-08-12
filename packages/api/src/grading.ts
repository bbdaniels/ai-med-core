/**
 * Real-time grading service for AI-MED submissions.
 * Ports logic from eval/scripts/grade.py for TypeScript runtime.
 */

import { OpenAI } from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { logTokenUsage, activeProjectPrefix, getProjectSetting } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

const useGateway = !!process.env.OPENAI_BASE_URL;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || undefined,
  defaultHeaders: useGateway ? { 'api-key': process.env.OPENAI_API_KEY || '' } : undefined,
});

// Direct OpenAI client for projects that bill directly (not via Harvard gateway).
// Mirrors server.ts: reuses OPENAI_TTS_KEY against the public OpenAI endpoint.
const OPENAI_DIRECT_URL = 'https://api.openai.com/v1';
const openaiDirect = process.env.OPENAI_TTS_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_TTS_KEY, baseURL: OPENAI_DIRECT_URL })
  : null;

async function resolveGradingClient(projectSlug: string): Promise<OpenAI> {
  const paymentSource = await getProjectSetting(projectSlug, 'payment_source');
  return (paymentSource === 'direct' && openaiDirect) ? openaiDirect : openai;
}

const MODEL = 'gpt-4o-mini'; // Fast, lightweight model for real-time student feedback

// ── Types ──────────────────────────────────────────────────────────

export interface RubricItem {
  id: string;
  item_number?: string;
  description: string;
  scoring: string;
  max_points: number;
  grading_rubric: string;
  data_source?: string;
}

export interface RubricCategory {
  name: string;
  max_points: number;
  items: RubricItem[];
}

export interface Rubric {
  name: string;
  version: string;
  source: string;
  total_points?: number;
  categories?: RubricCategory[];
  sections?: ChecklistSection[];
}

export interface ChecklistSection {
  name: string;
  items: ChecklistItem[];
}

export interface ChecklistItem {
  id: string;
  question?: string;
  topic?: string;
  criterion?: string;
  look_for?: string;
}

export interface RubricScore {
  id: string;
  score: number;
  evidence: string | null;
}

export interface ScoringRubricResult {
  total_score: number;
  max_score: number;
  category_scores: Record<string, number>;
  rubric_scores: RubricScore[];
  overall_notes: string;
}

export interface ChecklistItemResult {
  id: string;
  asked?: boolean;
  present?: boolean;
  evidence: string | null;
}

export interface ChecklistResult {
  completed: number;
  total: number;
  section_scores: Record<string, { completed: number; total: number }>;
  items: ChecklistItemResult[];
}

export interface GradingResult {
  rubric_key: string;
  rubric_name: string;
  result: ScoringRubricResult | ChecklistResult;
}

// ── Helper Functions ───────────────────────────────────────────────

/**
 * Extract only user messages from transcript.
 * Port of extract_user_messages from grade.py (lines 71-96)
 */
function extractUserMessages(transcript: string): string[] {
  const lines = transcript.split('\n');
  const userMessages: string[] = [];
  let currentMessage: string[] = [];
  let inUser = false;

  for (const line of lines) {
    if (line.startsWith('User:')) {
      if (currentMessage.length > 0 && inUser) {
        userMessages.push(currentMessage.join(' '));
      }
      inUser = true;
      const text = line.slice(5).trim();
      currentMessage = text ? [text] : [];
    } else if (line.startsWith('Patient:') || line.startsWith('Assistant:') || line.startsWith('Nurse:')) {
      if (currentMessage.length > 0 && inUser) {
        userMessages.push(currentMessage.join(' '));
      }
      inUser = false;
      currentMessage = [];
    } else if (inUser) {
      currentMessage.push(line.trim());
    }
  }

  if (currentMessage.length > 0 && inUser) {
    userMessages.push(currentMessage.join(' '));
  }

  return userMessages;
}

/**
 * Build grading prompt for scoring rubric.
 * Port of build_scoring_rubric_prompt from grade.py (lines 128-171)
 */
function buildScoringRubricPrompt(
  text: string,
  rubric: Rubric,
  isTranscript: boolean,
  language: string
): string {
  let textDesc: string;
  let textContent: string;

  if (isTranscript) {
    const userMessages = extractUserMessages(text);
    textDesc = "STUDENT'S QUESTIONS/STATEMENTS";
    textContent = userMessages.filter(msg => msg.trim()).map(msg => `- ${msg}`).join('\n');
  } else {
    textDesc = "STUDENT'S WRITTEN RESPONSE";
    textContent = text;
  }

  const rubricItems = (rubric.categories || []).flatMap(category =>
    category.items
      .filter(item => item.data_source !== 'survey_time')
      .map(item => ({
        id: item.id,
        category: category.name,
        description: item.description,
        grading_rubric: item.grading_rubric,
      }))
  );

  const languageInstruction = language !== 'en'
    ? `\n\nCRITICAL: You MUST write ALL text (including overall_notes) in the language with ISO 639-1 code: ${language}. Do NOT use English.`
    : '';

  return `You are grading a medical student's interaction with a simulated patient.${languageInstruction}

## ${textDesc}:
${textContent}

## SCORING RUBRIC ITEMS:
For each item, determine if the student addressed it (score=1) or not (score=0).
Provide a brief quote as evidence if scored=1.

${JSON.stringify(rubricItems, null, 2)}

## RESPONSE FORMAT:
Return a JSON object:
{
  "rubric_scores": [
    {"id": "item_id", "score": 0 or 1, "evidence": "quote or null"}
  ],
  "overall_notes": "Brief assessment"
}

Return ONLY valid JSON.`;
}

/**
 * Build grading prompt for checklist.
 * Port of build_checklist_prompt from grade.py (lines 173-218)
 */
function buildChecklistPrompt(
  text: string,
  checklist: Rubric,
  isTranscript: boolean,
  language: string
): string {
  let textDesc: string;
  let textContent: string;

  if (isTranscript) {
    const userMessages = extractUserMessages(text);
    textDesc = "STUDENT'S QUESTIONS/STATEMENTS";
    textContent = userMessages.filter(msg => msg.trim()).map(msg => `- ${msg}`).join('\n');
  } else {
    textDesc = "STUDENT'S WRITTEN RESPONSE";
    textContent = text;
  }

  const checklistItems = (checklist.sections || []).flatMap(section =>
    section.items.map(item => {
      const entry: Record<string, string> = { id: item.id, section: section.name };
      if ('question' in item && item.question) {
        entry.question = item.question;
        entry.topic = item.topic || '';
      } else if ('criterion' in item && item.criterion) {
        entry.criterion = item.criterion;
        entry.look_for = item.look_for || '';
      }
      return entry;
    })
  );

  // Use "asked" for question checklists, "present" for assessment checklists
  const hasQuestions = checklistItems.some(item => 'question' in item);
  const fieldName = hasQuestions ? 'asked' : 'present';
  const fieldDesc = hasQuestions ? 'asked about this topic' : 'present in the text';

  const languageInstruction = language !== 'en'
    ? `\n\nCRITICAL: You MUST write ALL text (including evidence quotes) in the language with ISO 639-1 code: ${language}. Do NOT use English.`
    : '';

  return `Analyze this medical student's response.${languageInstruction}

## ${textDesc}:
${textContent}

## CHECKLIST:
For each item, determine if it was ${fieldDesc} (true/false).

${JSON.stringify(checklistItems, null, 2)}

## RESPONSE FORMAT:
Return a JSON object:
{
  "items": [
    {"id": "item_id", "${fieldName}": true or false, "evidence": "quote or null"}
  ]
}

Return ONLY valid JSON.`;
}

/**
 * Call OpenAI GPT-4o with language-specific system message.
 * Includes retry logic with exponential backoff for rate limiting.
 * Port of call_openai from grade.py (lines 221-236)
 */
async function callOpenAI(
  prompt: string,
  language: string,
  client: OpenAI,
  retries = 3
): Promise<any> {
  const systemMsg = language !== 'en'
    ? `You are an expert medical education evaluator. Return only valid JSON.

CRITICAL: ALL text in your response MUST be written in the language with ISO 639-1 code: ${language}. This is non-negotiable. Every single word must be in this language, not in English.`
    : 'You are an expert medical education evaluator. Return only valid JSON.';

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      });

      // Log token usage (including Harvard gateway credit fields if present)
      if (response.usage) {
        const u = response.usage;
        const raw = response as any;
        const costPerPrompt = 0.15 / 1_000_000;
        const costPerCompletion = 0.60 / 1_000_000;
        logTokenUsage({
          project: activeProjectPrefix(),
          endpoint: '/api/grade-session',
          model: MODEL,
          prompt_tokens: u.prompt_tokens || 0,
          completion_tokens: u.completion_tokens || 0,
          estimated_cost: (u.prompt_tokens || 0) * costPerPrompt + (u.completion_tokens || 0) * costPerCompletion,
          harvard_credits_used: raw.your_harvard_credits_used_this_transaction ?? null,
          harvard_credits_remaining: raw.your_harvard_credits_still_available ?? null,
        });
      }

      return JSON.parse(response.choices[0].message.content || '{}');
    } catch (error: any) {
      const isRateLimit = error?.status === 429;
      const isLastAttempt = attempt === retries - 1;

      if (isRateLimit && !isLastAttempt) {
        // Exponential backoff: 2s, 4s, 8s, etc.
        const delay = Math.pow(2, attempt + 1) * 1000;
        console.log(`Rate limit hit, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      console.error('OpenAI error:', error);
      return null;
    }
  }

  return null;
}

/**
 * Grade a scoring rubric and return structured results.
 * Port of grade_scoring_rubric from grade.py (lines 242-273)
 */
async function gradeScoringRubric(
  text: string,
  rubric: Rubric,
  isTranscript: boolean,
  language: string,
  client: OpenAI,
  timeScore = 0
): Promise<ScoringRubricResult | null> {
  const prompt = buildScoringRubricPrompt(text, rubric, isTranscript, language);
  const aiResult = await callOpenAI(prompt, language, client);
  if (!aiResult) {
    console.log('[GRADING] callOpenAI returned null');
    return null;
  }

  console.log('[GRADING] AI result keys:', Object.keys(aiResult));
  console.log('[GRADING] Has rubric_scores:', !!aiResult.rubric_scores);
  console.log('[GRADING] rubric_scores length:', aiResult.rubric_scores?.length || 0);

  const scoresMap = new Map<string, RubricScore>(
    (aiResult.rubric_scores || []).map((r: RubricScore) => [r.id, r])
  );

  const categoryScores: Record<string, number> = {};
  let total = 0;
  let maxTotal = 0;

  // Build lookup map for rubric items to enrich LLM response
  const itemLookup = new Map<string, { category: string; description: string; grading_rubric: string }>();
  for (const category of rubric.categories || []) {
    for (const item of category.items) {
      itemLookup.set(item.id, {
        category: category.name,
        description: item.description,
        grading_rubric: item.grading_rubric,
      });
    }
  }

  for (const category of rubric.categories || []) {
    let catScore = 0;
    const catMax = category.max_points || 0;

    for (const item of category.items) {
      if (item.data_source === 'survey_time') {
        catScore += timeScore;
      } else {
        const score = scoresMap.get(item.id);
        if (score) {
          catScore += score.score || 0;
        }
      }
    }

    categoryScores[category.name] = catScore;
    total += catScore;
    maxTotal += catMax;
  }

  // Enrich rubric_scores with category, description, and grading_rubric from original rubric
  const enrichedScores = (aiResult.rubric_scores || []).map((score: RubricScore) => {
    const itemData = itemLookup.get(score.id);
    return {
      ...score,
      category: itemData?.category || 'General',
      description: itemData?.description || score.id,
      grading_rubric: itemData?.grading_rubric || '',
    };
  });

  return {
    total_score: total,
    max_score: maxTotal,
    category_scores: categoryScores,
    rubric_scores: enrichedScores,
    overall_notes: aiResult.overall_notes || '',
  };
}

/**
 * Grade a checklist and return structured results.
 * Port of grade_checklist from grade.py (lines 276-304)
 */
async function gradeChecklist(
  text: string,
  checklist: Rubric,
  isTranscript: boolean,
  language: string,
  client: OpenAI
): Promise<ChecklistResult | null> {
  const prompt = buildChecklistPrompt(text, checklist, isTranscript, language);
  const aiResult = await callOpenAI(prompt, language, client);
  if (!aiResult) {
    return null;
  }

  const items: ChecklistItemResult[] = aiResult.items || [];
  const hasQuestions = (checklist.sections || []).some(section =>
    section.items.some(item => 'question' in item)
  );
  const field = hasQuestions ? 'asked' : 'present';

  // Build lookup map for checklist items to enrich LLM response
  const itemLookup = new Map<string, { section: string; criterion?: string; question?: string; look_for?: string; topic?: string }>();
  for (const section of checklist.sections || []) {
    for (const item of section.items) {
      itemLookup.set(item.id, {
        section: section.name,
        criterion: item.criterion,
        question: item.question,
        look_for: item.look_for,
        topic: item.topic,
      });
    }
  }

  // Enrich items with section, criterion/question, and look_for/topic from original checklist
  const enrichedItems = items.map((item) => {
    const itemData = itemLookup.get(item.id);
    return {
      ...item,
      section: itemData?.section || 'General',
      criterion: itemData?.criterion,
      question: itemData?.question,
      look_for: itemData?.look_for,
      topic: itemData?.topic,
    };
  });

  const completed = enrichedItems.filter(item => item[field as keyof ChecklistItemResult]).length;
  const totalItems = (checklist.sections || []).reduce(
    (sum, section) => sum + section.items.length,
    0
  );

  const sectionScores: Record<string, { completed: number; total: number }> = {};
  const itemsMap = new Map(enrichedItems.map(item => [item.id, item]));

  for (const section of checklist.sections || []) {
    const sectionIds = section.items.map(item => item.id);
    sectionScores[section.name] = {
      completed: sectionIds.filter(id => {
        const item = itemsMap.get(id);
        return item && item[field as keyof ChecklistItemResult];
      }).length,
      total: sectionIds.length,
    };
  }

  return {
    completed,
    total: totalItems,
    section_scores: sectionScores,
    items: enrichedItems,
  };
}

/**
 * Fallback templates for when LLM synthesis fails.
 * Provides basic translated phrases for common languages.
 */
const FALLBACK_TEMPLATES: Record<string, { question: string; criterion: string; addressed: string }> = {
  en: { question: 'Next time, try asking:', criterion: 'Next time, consider:', addressed: 'You addressed' },
  fr: { question: 'La prochaine fois, essayez de demander :', criterion: 'La prochaine fois, considérez :', addressed: 'Vous avez abordé' },
  es: { question: 'La próxima vez, intente preguntar:', criterion: 'La próxima vez, considere:', addressed: 'Usted abordó' },
  zh: { question: '下次尝试询问：', criterion: '下次考虑：', addressed: '您讨论了' },
  hi: { question: 'अगली बार पूछने का प्रयास करें:', criterion: 'अगली बार विचार करें:', addressed: 'आपने चर्चा की' },
  sw: { question: 'Mara ijayo, jaribu kuuliza:', criterion: 'Mara ijayo, zingatia:', addressed: 'Ulijadili' },
  th: { question: 'ครั้งหน้าลองถามว่า:', criterion: 'ครั้งหน้าพิจารณา:', addressed: 'คุณได้พูดถึง' },
};

/**
 * Synthesize raw grading results into focused, actionable feedback for learners.
 * Returns 2-4 strengths and 3-5 growth areas without revealing the complete rubric.
 */
export async function synthesizeFeedback(
  gradingResults: GradingResult[],
  language: string,
  projectName: string
): Promise<{ strengths: Array<{ title: string; description: string }>; growthAreas: Array<{ title: string; description: string }> }> {
  const client = await resolveGradingClient(projectName);
  // Extract scored items with evidence for strengths
  const scoredItems: Array<{ description: string; evidence: string; category: string }> = [];
  const missedItems: Array<{ description: string; rubric: string; category: string }> = [];

  for (const grading of gradingResults) {
    const result = grading.result;

    // Process scoring rubrics
    if ('rubric_scores' in result) {
      for (const score of result.rubric_scores || []) {
        if (score.score > 0 && score.evidence) {
          scoredItems.push({
            description: (score as any).description || score.id,
            evidence: score.evidence,
            category: (score as any).category || 'General',
          });
        } else if (score.score === 0) {
          missedItems.push({
            description: (score as any).description || score.id,
            rubric: (score as any).grading_rubric || '',
            category: (score as any).category || 'General',
          });
        }
      }
    }

    // Process checklists
    if ('items' in result) {
      for (const item of result.items || []) {
        const addressed = (item as any).asked || (item as any).present || (item as any).addressed;
        if (addressed && item.evidence) {
          scoredItems.push({
            description: (item as any).criterion || (item as any).question || item.id,
            evidence: item.evidence,
            category: (item as any).section || 'General',
          });
        } else if (!addressed) {
          missedItems.push({
            description: (item as any).criterion || (item as any).question || item.id,
            rubric: (item as any).look_for || (item as any).topic || '',
            category: (item as any).section || 'General',
          });
        }
      }
    }
  }

  // Guard: Don't synthesize if there's no real evidence
  console.log(`[SYNTHESIS] Scored items with evidence: ${scoredItems.length}`);
  console.log(`[SYNTHESIS] Missed items: ${missedItems.length}`);

  if (scoredItems.length === 0) {
    console.log('[SYNTHESIS] No scored items with evidence - returning empty feedback');
    const templates = FALLBACK_TEMPLATES[language] || FALLBACK_TEMPLATES['en'];
    return {
      strengths: [],
      growthAreas: missedItems.slice(0, 5).map(item => {
        // For question checklists, description is the question itself
        // For assessment checklists, description is the criterion
        const isQuestion = item.description.endsWith('?');
        // Use first 3-4 words of description as title (avoid English category names)
        const titleWords = item.description.split(' ').slice(0, isQuestion ? 4 : 3).join(' ');
        const title = titleWords + (titleWords.length < item.description.length ? '...' : '');
        return {
          title,
          description: isQuestion
            ? `${templates.question} "${item.description}"`
            : `${templates.criterion} ${item.description.toLowerCase()}`,
        };
      }),
    };
  }

  const languageInstruction = language !== 'en'
    ? `\n\n🌍 CRITICAL REQUIREMENT: You MUST provide ALL feedback text in the language with ISO 639-1 code: ${language}. This includes strength titles, strength descriptions, growth area titles, and growth area descriptions. Do NOT use English unless the language code is 'en'.`
    : '';

  const prompt = `You are providing focused, actionable feedback to a medical student after a clinical encounter.${languageInstruction}

## WHAT THEY EXPLORED (items they addressed):
${scoredItems.map(item => `- ${item.description} (${item.category}): "${item.evidence}"`).join('\n')}

## WHAT THEY MISSED (items not addressed):
${missedItems.map(item => `- ${item.description} (${item.category}): ${item.rubric}`).join('\n')}

## YOUR TASK:
Generate focused, pedagogically sound feedback that helps the learner grow WITHOUT revealing the complete assessment rubric.

CRITICAL RULES:
- If the "WHAT THEY EXPLORED" list above is empty or has no real quotes, return empty strengths array: {"strengths": []}
- Do NOT make up quotes or examples that aren't in the evidence list
- Do NOT be generous or give credit for things not explicitly shown

1. **Strengths (2-4 items)**: ONLY include items with EXACT QUOTES from the evidence above. Do NOT infer, assume, or be generous.
   - CRITICAL: Every strength MUST reference a direct quote from the "WHAT THEY EXPLORED" evidence list above
   - If no items in the evidence list, return empty array
   - Format: {"title": "Brief strength name", "description": "You [action] by saying/asking '[EXACT QUOTE]'"}
   - Example: {"title": "Expressed empathy", "description": "You showed compassion by saying 'How has this affected you?'"}
   - DO NOT paraphrase or summarize - use the actual words the student said
   - If there are fewer than 2 items with clear evidence, that's OK - be conservative, not generous

2. **Growth Areas (3-5 items)**: Identify high-impact opportunities. Use actionable "next time" language.
   - Format: {"title": "Brief area name", "description": "Next time, try... [actionable suggestion]"}
   - Example: {"title": "Explore home safety", "description": "Next time, ask about environmental hazards like loose rugs, grab bars, or lighting that could contribute to falls"}
   - Prioritize clinical importance over comprehensiveness
   - Use learner-friendly language, not rubric jargon
   - Make concrete and actionable

## RESPONSE FORMAT:
${language !== 'en' ? `REMINDER: All text in the response MUST be in language code: ${language}\n\n` : ''}Return ONLY valid JSON:
{
  "strengths": [
    {"title": "...", "description": "..."}
  ],
  "growthAreas": [
    {"title": "...", "description": "..."}
  ]
}`;

  const aiResult = await callOpenAI(prompt, language, client);
  if (!aiResult) {
    // Fallback to simple summary if synthesis fails
    const templates = FALLBACK_TEMPLATES[language] || FALLBACK_TEMPLATES['en'];
    return {
      strengths: scoredItems.slice(0, 3).map(item => {
        // Use first 3-4 words of description as title (avoid English category names)
        const titleWords = item.description.split(' ').slice(0, 4).join(' ');
        const title = titleWords + (titleWords.length < item.description.length ? '...' : '');
        return {
          title,
          description: `${templates.addressed} "${item.description.substring(0, 100)}..."`,
        };
      }),
      growthAreas: missedItems.slice(0, 5).map(item => {
        // For question checklists, description is the question itself
        // For assessment checklists, description is the criterion
        const isQuestion = item.description.endsWith('?');
        const titleWords = item.description.split(' ').slice(0, isQuestion ? 4 : 3).join(' ');
        const title = titleWords + (titleWords.length < item.description.length ? '...' : '');
        return {
          title,
          description: isQuestion
            ? `${templates.question} "${item.description}"`
            : `${templates.criterion} ${item.description.toLowerCase()}`,
        };
      }),
    };
  }

  return {
    strengths: aiResult.strengths || [],
    growthAreas: aiResult.growthAreas || [],
  };
}

/**
 * Discover all rubric/checklist JSON files in a project case directory.
 * Port of discover_rubrics from grade.py (lines 36-48)
 */
async function discoverRubrics(projectName: string, template: string): Promise<Map<string, Rubric>> {
  const rubricDir = path.join(REPO_ROOT, 'projects', projectName, 'cases', template);
  const rubrics = new Map<string, Rubric>();

  try {
    const files = await fs.readdir(rubricDir);
    const rubricFiles = files
      .filter(f => f.endsWith('_rubric.json') || f.endsWith('_checklist.json'))
      .sort();

    for (const file of rubricFiles) {
      const key = file.replace(/\.json$/, '');
      const content = await fs.readFile(path.join(rubricDir, file), 'utf-8');
      const rubric = JSON.parse(content) as Rubric;
      rubrics.set(key, rubric);
      console.log(`  Loaded rubric: ${key} (source: ${rubric.source || 'transcript'})`);
    }
  } catch (error) {
    console.error(`Failed to discover rubrics for ${projectName}/${template}:`, error);
  }

  return rubrics;
}

/**
 * Grade all submissions in a session (parallel GPT-4o calls).
 */
export async function gradeSession(
  submissions: Array<{
    token: string;
    transcript: string;
    vignetteId: string;
    caseTemplate: string;
    language: string;
  }>,
  projectName: string
): Promise<Map<string, GradingResult[]>> {
  const results = new Map<string, GradingResult[]>();

  // Resolve OpenAI client once per session based on per-project payment_source
  const client = await resolveGradingClient(projectName);

  // Group submissions by template to load rubrics once per template
  const templateGroups = new Map<string, typeof submissions>();
  for (const sub of submissions) {
    if (!templateGroups.has(sub.caseTemplate)) {
      templateGroups.set(sub.caseTemplate, []);
    }
    templateGroups.get(sub.caseTemplate)!.push(sub);
  }

  // Grade each template group
  for (const [template, subs] of templateGroups.entries()) {
    console.log(`[gradeSession] Processing template group: ${JSON.stringify(template)}`);
    console.log(`[gradeSession]   Type: ${typeof template}`);
    console.log(`[gradeSession]   Submissions in group: ${subs.length}`);
    const rubrics = await discoverRubrics(projectName, template);

    // Grade all submissions in parallel
    const gradingTasks = subs.map(async sub => {
      const rubricResults: GradingResult[] = [];

      // Grade each rubric for this submission
      for (const [rubricKey, rubric] of rubrics.entries()) {
        const source = rubric.source || 'transcript';
        const isTranscript = source === 'transcript';

        // Skip field-sourced rubrics (require Kobo form field data)
        if (source.startsWith('field:')) {
          console.log(`  Skipping field-sourced rubric ${rubricKey} for responsive grading`);
          continue;
        }

        let result: ScoringRubricResult | ChecklistResult | null = null;

        if (rubric.categories) {
          // Scoring rubric
          result = await gradeScoringRubric(sub.transcript, rubric, isTranscript, sub.language, client);
        } else if (rubric.sections) {
          // Checklist
          result = await gradeChecklist(sub.transcript, rubric, isTranscript, sub.language, client);
        }

        if (result) {
          rubricResults.push({
            rubric_key: rubricKey,
            rubric_name: rubric.name,
            result,
          });
        }
      }

      return { token: sub.token, rubricResults };
    });

    const gradedSubs = await Promise.all(gradingTasks);
    for (const { token, rubricResults } of gradedSubs) {
      results.set(token, rubricResults);
    }
  }

  return results;
}
