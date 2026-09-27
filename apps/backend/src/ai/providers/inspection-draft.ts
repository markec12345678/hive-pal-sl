/**
 * Inspection draft pipeline — ported from the retired Python AI service
 * (apps/ai-app/app.py). Pure functions only: no NestJS, no SDK imports.
 *
 * Pipeline: transcript -> LLM prompt -> raw AI JSON -> normalize -> form draft.
 * The resulting "form draft" shape is what the frontend merges into the
 * inspection form (see use-inspection-ai-merge / inspection-ai-merge lib).
 */

export const MAX_TRANSCRIPT_CHARS = 12_000;

/** JSON Schema used to constrain the LLM output (OpenAI-compatible providers). */
export const INSPECTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    hiveId: { type: ['string', 'null'] },
    date: {
      type: ['string', 'null'],
      description:
        'ISO 8601 datetime string if the transcript clearly states the inspection date/time; otherwise null',
    },
    temperature: { type: ['number', 'null'] },
    weatherConditions: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] },
    observations: {
      type: 'object',
      properties: {
        strength: { type: ['integer', 'null'], minimum: 0 },
        uncappedBrood: { type: ['integer', 'null'], minimum: 0, maximum: 10 },
        cappedBrood: { type: ['integer', 'null'], minimum: 0, maximum: 10 },
        honeyStores: { type: ['integer', 'null'], minimum: 0, maximum: 10 },
        pollenStores: { type: ['integer', 'null'], minimum: 0, maximum: 10 },
        totalFrames: { type: ['integer', 'null'], minimum: 0 },
        eggsFrames: { type: ['integer', 'null'], minimum: 0 },
        uncappedBroodFrames: { type: ['integer', 'null'], minimum: 0 },
        cappedBroodFrames: { type: ['integer', 'null'], minimum: 0 },
        droneBroodFrames: { type: ['integer', 'null'], minimum: 0 },
        pollenFrames: { type: ['integer', 'null'], minimum: 0 },
        nectarFrames: { type: ['integer', 'null'], minimum: 0 },
        honeyFrames: { type: ['integer', 'null'], minimum: 0 },
        emptyFrames: { type: ['integer', 'null'], minimum: 0 },
        queenCells: { type: ['integer', 'null'], minimum: 0 },
        swarmCells: { type: ['boolean', 'null'] },
        supersedureCells: { type: ['boolean', 'null'] },
        queenSeen: { type: ['boolean', 'null'] },
        broodPattern: {
          type: ['string', 'null'],
          enum: [
            'solid',
            'spotty',
            'scattered',
            'patchy',
            'excellent',
            'poor',
            null,
          ],
        },
        additionalObservations: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'calm',
              'defensive',
              'aggressive',
              'nervous',
              'varroa_present',
              'small_hive_beetle',
              'wax_moths',
              'ants_present',
              'healthy',
              'active',
              'sluggish',
              'thriving',
            ],
          },
        },
        reminderObservations: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'honey_bound',
              'overcrowded',
              'needs_super',
              'queen_issues',
              'requires_treatment',
              'low_stores',
              'prepare_for_winter',
            ],
          },
        },
      },
      required: [
        'strength',
        'uncappedBrood',
        'cappedBrood',
        'honeyStores',
        'pollenStores',
        'totalFrames',
        'eggsFrames',
        'uncappedBroodFrames',
        'cappedBroodFrames',
        'droneBroodFrames',
        'pollenFrames',
        'nectarFrames',
        'honeyFrames',
        'emptyFrames',
        'queenCells',
        'swarmCells',
        'supersedureCells',
        'queenSeen',
        'broodPattern',
        'additionalObservations',
        'reminderObservations',
      ],
    },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: [
              'FEEDING',
              'TREATMENT',
              'FRAME',
              'MAINTENANCE',
              'NOTE',
              'OTHER',
            ],
          },
          notes: { type: ['string', 'null'] },
          details: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: [
                  'FEEDING',
                  'TREATMENT',
                  'FRAME',
                  'MAINTENANCE',
                  'NOTE',
                  'OTHER',
                ],
              },
              feedType: { type: ['string', 'null'] },
              amount: { type: ['number', 'null'] },
              unit: { type: ['string', 'null'] },
              concentration: { type: ['string', 'null'] },
              product: { type: ['string', 'null'] },
              quantity: { type: ['number', 'null'] },
              duration: { type: ['string', 'null'] },
              component: {
                type: ['string', 'null'],
                enum: ['BOX', 'BOTTOM_BOARD', 'COVER', null],
              },
              status: {
                type: ['string', 'null'],
                enum: ['CLEANED', 'REPLACED', null],
              },
              content: { type: ['string', 'null'] },
            },
            required: ['type'],
          },
        },
        required: ['type', 'details'],
      },
    },
  },
  required: [
    'hiveId',
    'date',
    'temperature',
    'weatherConditions',
    'notes',
    'observations',
    'actions',
  ],
} as const;

export interface RawAiRecommendation {
  hiveId?: string | null;
  date?: string | null;
  temperature?: number | null;
  weatherConditions?: string | null;
  notes?: string | null;
  observations?: Record<string, unknown> | null;
  actions?: Array<Record<string, unknown>> | null;
}

export interface InspectionActionDraft {
  type: 'FEEDING' | 'TREATMENT' | 'FRAME' | 'MAINTENANCE' | 'NOTE' | 'OTHER';
  // FEEDING
  feedType?: string;
  quantity?: number | null;
  unit?: string;
  concentration?: string;
  // TREATMENT
  treatmentType?: string;
  amount?: number | null;
  // FRAME
  frames?: number | null;
  // MAINTENANCE
  component?: string;
  status?: string;
  // all
  notes?: string;
  [key: string]: unknown;
}

export interface InspectionFormDraft {
  temperature: number | null;
  weatherConditions: string | null;
  notes: string | null;
  observations: {
    strength: number | null;
    uncappedBrood: number | null;
    cappedBrood: number | null;
    honeyStores: number | null;
    pollenStores: number | null;
    totalFrames: number | null;
    eggsFrames: number | null;
    uncappedBroodFrames: number | null;
    cappedBroodFrames: number | null;
    droneBroodFrames: number | null;
    pollenFrames: number | null;
    nectarFrames: number | null;
    honeyFrames: number | null;
    emptyFrames: number | null;
    queenCells: number | null;
    swarmCells: boolean | null;
    supersedureCells: boolean | null;
    queenSeen: boolean | null;
    broodPattern: string | null;
    additionalObservations: string[];
    reminderObservations: string[];
  };
  actions: InspectionActionDraft[];
}

export function emptyFormDraft(): InspectionFormDraft {
  return {
    temperature: null,
    weatherConditions: null,
    notes: null,
    observations: {
      strength: null,
      uncappedBrood: null,
      cappedBrood: null,
      honeyStores: null,
      pollenStores: null,
      totalFrames: null,
      eggsFrames: null,
      uncappedBroodFrames: null,
      cappedBroodFrames: null,
      droneBroodFrames: null,
      pollenFrames: null,
      nectarFrames: null,
      honeyFrames: null,
      emptyFrames: null,
      queenCells: null,
      swarmCells: null,
      supersedureCells: null,
      queenSeen: null,
      broodPattern: null,
      additionalObservations: [],
      reminderObservations: [],
    },
    actions: [],
  };
}

export function truncateTranscript(
  text: string,
  maxChars = MAX_TRANSCRIPT_CHARS,
): string {
  return (text ?? '').trim().slice(0, maxChars);
}

export function buildInspectionPrompt(transcript: string): string {
  return `
You extract structured hive inspection data from a beekeeper's spoken transcript.

Return JSON that matches the provided schema exactly.

Hard rules:
- Be conservative.
- Do not invent facts.
- Only include information explicitly stated or clearly implied.
- Use the exact field names and enum values from the schema.
- Do not return extra keys.
- If a value is unknown, use null.
- If a list field is unknown, return [].
- If notes are unknown, return null.
- If no actions are mentioned, return [].
- If no observations are mentioned, keep the observations object but set its unknown values to null and arrays to [].

Field mapping rules:
- hiveId:
  - only fill this if the transcript explicitly contains a real HivePal hive UUID
  - otherwise null
- date:
  - only fill if a clear inspection date/time is spoken
  - return ISO-8601 string if known, otherwise null
- temperature:
  - numeric only
  - do not wrap inside a weather object
- weatherConditions:
  - short free-text weather description from transcript if stated, otherwise null
- notes:
  - concise free-text summary of notable inspection notes from transcript
  - keep it short and factual

Observations object:
This app supports two inspection styles. Fill whichever the transcript supports;
fill both if both are mentioned. Leave anything unstated as null.

Subjective 0-10 ratings (only if the beekeeper gives a rating/impression, not a frame count):
- strength: hive/population strength. If given as a 0-10 rating use that. If given as a
  number of occupied/covered frames, put that frame count here (no upper bound).
- uncappedBrood: 0-10 rating if stated/implied, else null
- cappedBrood: 0-10 rating if stated/implied, else null
- honeyStores: 0-10 rating if stated/implied, else null
- pollenStores: 0-10 rating if stated/implied, else null

Frame counts (only if the beekeeper states an actual number of frames):
These are independent, non-negative integer counts and may overlap (one frame can
hold both eggs and pollen), so they need not sum to totalFrames.
- totalFrames: total number of frames in the hive/box, else null
- eggsFrames: frames containing eggs, else null
- uncappedBroodFrames: frames of uncapped/open brood, else null
- cappedBroodFrames: frames of capped/sealed brood, else null
- droneBroodFrames: frames of drone brood, else null
- pollenFrames: frames of pollen, else null
- nectarFrames: frames of nectar, else null
- honeyFrames: frames of capped honey, else null
- emptyFrames: empty/undrawn frames, else null

Other observations:
- queenCells: integer count if stated; if explicitly none, use 0; if unknown, null
- swarmCells: true/false/null
- supersedureCells: true/false/null
- queenSeen: true/false/null
- broodPattern: must be exactly one of:
  solid, spotty, scattered, patchy, excellent, poor
- additionalObservations: only choose from:
  calm, defensive, aggressive, nervous, varroa_present, small_hive_beetle,
  wax_moths, ants_present, healthy, active, sluggish, thriving
- reminderObservations: only choose from:
  honey_bound, overcrowded, needs_super, queen_issues,
  requires_treatment, low_stores, prepare_for_winter

Actions:
Return only actions actually mentioned.
Each action must use this structure:
{
  "type": "FEEDING" | "TREATMENT" | "FRAME" | "MAINTENANCE" | "NOTE" | "OTHER",
  "notes": "optional short note or null",
  "details": { ... }
}

Action details rules:
- FEEDING details:
  {
    "type": "FEEDING",
    "feedType": string or null,
    "amount": number or null,
    "unit": string or null,
    "concentration": string or null
  }
- TREATMENT details:
  {
    "type": "TREATMENT",
    "product": string or null,
    "quantity": number or null,
    "unit": string or null,
    "duration": string or null
  }
- FRAME details:
  {
    "type": "FRAME",
    "quantity": integer or null
  }
- MAINTENANCE details:
  {
    "type": "MAINTENANCE",
    "component": "BOX" | "BOTTOM_BOARD" | "COVER" | null,
    "status": "CLEANED" | "REPLACED" | null
  }
- NOTE details:
  {
    "type": "NOTE",
    "content": string or null
  }
- OTHER details:
  {
    "type": "OTHER"
  }

Normalization examples:
- "patch" -> "patchy"
- "varroa mites present" -> "varroa_present"
- "small hive beetle" -> "small_hive_beetle"
- "ants present" -> "ants_present"
- "needs a super" -> "needs_super"
- "queen issues" -> "queen_issues"
- "requires treatment" -> "requires_treatment"
- "low stores" -> "low_stores"
- "prepare for winter" -> "prepare_for_winter"

Transcript:
${transcript}
`.trim();
}

const BROOD_PATTERN_MAP: Record<string, string | null> = {
  patch: 'patchy',
  patchy: 'patchy',
  solid: 'solid',
  spotty: 'spotty',
  scattered: 'scattered',
  excellent: 'excellent',
  poor: 'poor',
  '': null,
};

const ADDITIONAL_MAP: Record<string, string> = {
  'varroa mites present': 'varroa_present',
  varroa_present: 'varroa_present',
  'small hive beetle': 'small_hive_beetle',
  small_hive_beetle: 'small_hive_beetle',
  'wax moths': 'wax_moths',
  wax_moths: 'wax_moths',
  'ants present': 'ants_present',
  ants_present: 'ants_present',
  calm: 'calm',
  defensive: 'defensive',
  aggressive: 'aggressive',
  nervous: 'nervous',
  healthy: 'healthy',
  active: 'active',
  sluggish: 'sluggish',
  thriving: 'thriving',
};

const REMINDER_MAP: Record<string, string> = {
  'honey bound': 'honey_bound',
  honey_bound: 'honey_bound',
  overcrowded: 'overcrowded',
  'needs super': 'needs_super',
  needs_super: 'needs_super',
  'queen issues': 'queen_issues',
  queen_issues: 'queen_issues',
  'requires treatment': 'requires_treatment',
  requires_treatment: 'requires_treatment',
  'low stores': 'low_stores',
  low_stores: 'low_stores',
  'prepare for winter': 'prepare_for_winter',
  prepare_for_winter: 'prepare_for_winter',
};

const VALID_ADDITIONAL = new Set([
  'calm',
  'defensive',
  'aggressive',
  'nervous',
  'varroa_present',
  'small_hive_beetle',
  'wax_moths',
  'ants_present',
  'healthy',
  'active',
  'sluggish',
  'thriving',
]);

const VALID_REMINDERS = new Set([
  'honey_bound',
  'overcrowded',
  'needs_super',
  'queen_issues',
  'requires_treatment',
  'low_stores',
  'prepare_for_winter',
]);

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Normalize raw LLM output into a safe, schema-conformant object. */
export function normalizeRecommendation(data: unknown): RawAiRecommendation {
  const raw = (
    typeof data === 'object' && data !== null ? data : {}
  ) as RawAiRecommendation;
  const observations = raw.observations ?? {};
  const actions = Array.isArray(raw.actions) ? raw.actions : [];

  const additionalObservations = (
    Array.isArray(observations.additionalObservations)
      ? (observations.additionalObservations as unknown[])
      : []
  )
    .map((item) => ADDITIONAL_MAP[String(item)])
    .filter(
      (item): item is string => Boolean(item) && VALID_ADDITIONAL.has(item),
    );

  const reminderObservations = (
    Array.isArray(observations.reminderObservations)
      ? (observations.reminderObservations as unknown[])
      : []
  )
    .map((item) => REMINDER_MAP[String(item)])
    .filter(
      (item): item is string => Boolean(item) && VALID_REMINDERS.has(item),
    );

  const normalized: RawAiRecommendation = {
    hiveId: str(raw.hiveId),
    date: str(raw.date),
    temperature: num(raw.temperature),
    weatherConditions: str(raw.weatherConditions),
    notes: str(raw.notes),
    observations: {
      strength: num(observations.strength),
      uncappedBrood: num(observations.uncappedBrood),
      cappedBrood: num(observations.cappedBrood),
      honeyStores: num(observations.honeyStores),
      pollenStores: num(observations.pollenStores),
      totalFrames: num(observations.totalFrames),
      eggsFrames: num(observations.eggsFrames),
      uncappedBroodFrames: num(observations.uncappedBroodFrames),
      cappedBroodFrames: num(observations.cappedBroodFrames),
      droneBroodFrames: num(observations.droneBroodFrames),
      pollenFrames: num(observations.pollenFrames),
      nectarFrames: num(observations.nectarFrames),
      honeyFrames: num(observations.honeyFrames),
      emptyFrames: num(observations.emptyFrames),
      queenCells: num(observations.queenCells),
      swarmCells: bool(observations.swarmCells),
      supersedureCells: bool(observations.supersedureCells),
      queenSeen: bool(observations.queenSeen),
      broodPattern:
        BROOD_PATTERN_MAP[observations.broodPattern as string] ?? null,
      additionalObservations,
      reminderObservations,
    },
    actions: [],
  };

  const normalizedActions: Array<Record<string, unknown>> = [];
  for (const action of actions) {
    if (typeof action !== 'object' || action === null) continue;
    const a = action;
    const details = (a.details ?? {}) as Record<string, unknown>;
    const actionType = typeof a.type === 'string' ? a.type : '';

    if (actionType === 'FEEDING') {
      normalizedActions.push({
        type: 'FEEDING',
        notes: str(a.notes),
        details: {
          type: 'FEEDING',
          feedType: str(details.feedType),
          amount: num(details.amount),
          unit: str(details.unit),
          concentration: str(details.concentration),
        },
      });
    } else if (actionType === 'TREATMENT') {
      normalizedActions.push({
        type: 'TREATMENT',
        notes: str(a.notes),
        details: {
          type: 'TREATMENT',
          product: str(details.product),
          quantity: num(details.quantity),
          unit: str(details.unit),
          duration: str(details.duration),
        },
      });
    } else if (actionType === 'FRAME') {
      normalizedActions.push({
        type: 'FRAME',
        notes: str(a.notes),
        details: { type: 'FRAME', quantity: num(details.quantity) },
      });
    } else if (actionType === 'MAINTENANCE') {
      normalizedActions.push({
        type: 'MAINTENANCE',
        notes: str(a.notes),
        details: {
          type: 'MAINTENANCE',
          component: str(details.component),
          status: str(details.status),
        },
      });
    } else if (actionType === 'NOTE') {
      normalizedActions.push({
        type: 'NOTE',
        notes: str(a.notes),
        details: { type: 'NOTE', content: str(details.content) },
      });
    } else if (actionType === 'OTHER') {
      normalizedActions.push({
        type: 'OTHER',
        notes: str(a.notes),
        details: { type: 'OTHER' },
      });
    }
  }
  normalized.actions = normalizedActions;
  return normalized;
}

/** Map the normalized AI recommendation to the frontend form draft shape. */
export function mapAiToFormDraft(ai: RawAiRecommendation): InspectionFormDraft {
  const draft = emptyFormDraft();
  const observations = ai.observations ?? {};

  draft.temperature = ai.temperature ?? null;
  draft.weatherConditions = ai.weatherConditions ?? null;
  draft.notes = ai.notes ?? null;

  draft.observations = {
    strength: num(observations.strength),
    uncappedBrood: num(observations.uncappedBrood),
    cappedBrood: num(observations.cappedBrood),
    honeyStores: num(observations.honeyStores),
    pollenStores: num(observations.pollenStores),
    totalFrames: num(observations.totalFrames),
    eggsFrames: num(observations.eggsFrames),
    uncappedBroodFrames: num(observations.uncappedBroodFrames),
    cappedBroodFrames: num(observations.cappedBroodFrames),
    droneBroodFrames: num(observations.droneBroodFrames),
    pollenFrames: num(observations.pollenFrames),
    nectarFrames: num(observations.nectarFrames),
    honeyFrames: num(observations.honeyFrames),
    emptyFrames: num(observations.emptyFrames),
    queenCells: num(observations.queenCells),
    swarmCells: bool(observations.swarmCells),
    supersedureCells: bool(observations.supersedureCells),
    queenSeen: bool(observations.queenSeen),
    broodPattern: str(observations.broodPattern),
    additionalObservations: Array.isArray(observations.additionalObservations)
      ? (observations.additionalObservations as string[])
      : [],
    reminderObservations: Array.isArray(observations.reminderObservations)
      ? (observations.reminderObservations as string[])
      : [],
  };

  const mappedActions: InspectionActionDraft[] = [];
  for (const action of ai.actions ?? []) {
    if (typeof action !== 'object' || action === null) continue;
    const a = action;
    const details = (a.details ?? {}) as Record<string, unknown>;
    const actionType = typeof a.type === 'string' ? a.type : '';

    if (actionType === 'FEEDING') {
      mappedActions.push({
        type: 'FEEDING',
        feedType: str(details.feedType) ?? '',
        quantity: num(details.amount),
        unit: str(details.unit) ?? '',
        concentration: str(details.concentration) ?? '',
        notes: str(a.notes) ?? '',
      });
    } else if (actionType === 'TREATMENT') {
      mappedActions.push({
        type: 'TREATMENT',
        treatmentType: str(details.product) ?? '',
        amount: num(details.quantity),
        unit: str(details.unit) ?? '',
        notes: str(a.notes) ?? '',
      });
    } else if (actionType === 'FRAME') {
      mappedActions.push({
        type: 'FRAME',
        frames: num(details.quantity),
        notes: str(a.notes) ?? '',
      });
    } else if (actionType === 'MAINTENANCE') {
      mappedActions.push({
        type: 'MAINTENANCE',
        component: str(details.component) ?? '',
        status: str(details.status) ?? '',
        notes: str(a.notes) ?? '',
      });
    } else if (actionType === 'NOTE') {
      mappedActions.push({
        type: 'NOTE',
        notes: str(a.notes) ?? str(details.content) ?? '',
      });
    } else if (actionType === 'OTHER') {
      mappedActions.push({
        type: 'OTHER',
        notes: str(a.notes) ?? '',
      });
    }
  }

  draft.actions = mappedActions;
  return draft;
}

/** Parse an LLM response that should contain pure JSON (tolerates code fences). */
export function parseJsonContent(content: string): unknown {
  let text = (content ?? '').trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  }
  return JSON.parse(text);
}
