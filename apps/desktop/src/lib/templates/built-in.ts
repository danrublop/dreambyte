/**
 * Built-in scene templates that ship with Dreambyte.
 * Each template defines a layout and structure — the agent fills
 * placeholders with content when instantiating.
 */

import type { SceneTemplate, TemplateCategory } from './types'

function tmpl(
  id: string,
  name: string,
  description: string,
  category: TemplateCategory,
  tags: string[],
  opts: Partial<SceneTemplate> = {},
): SceneTemplate {
  return {
    id,
    name,
    description,
    category,
    tags,
    thumbnail: null,
    layers: [],
    duration: opts.duration ?? 8,
    styleOverride: opts.styleOverride ?? {},
    isBuiltIn: true,
    isPublic: true,
    authorId: null,
    useCount: 0,
    createdAt: new Date().toISOString(),
    placeholders: opts.placeholders ?? ['TITLE', 'SUBTITLE'],
    ...opts,
  }
}

// ── Title Cards ──────────────────────────────────────────────

const cleanTitle = tmpl(
  'clean-title',
  'Clean Title',
  'Centered title with subtitle and animated underline',
  'title-card',
  ['title', 'opening', 'intro'],
  { placeholders: ['TITLE', 'SUBTITLE'], duration: 6 },
)

const boldTitle = tmpl(
  'bold-title',
  'Bold Title',
  'Large bold text with accent color block and geometric decoration',
  'title-card',
  ['title', 'opening', 'bold', 'geometric'],
  { placeholders: ['TITLE', 'SUBTITLE'], duration: 6 },
)

const chalkboardTitle = tmpl(
  'chalkboard-title',
  'Chalkboard Title',
  'Dark green background with chalk-style handwritten text',
  'title-card',
  ['title', 'chalkboard', 'handwritten'],
  {
    placeholders: ['TITLE', 'SUBTITLE'],
    duration: 6,
    styleOverride: {
      palette: ['#fffef9', '#86efac', '#fbbf24', '#f87171'],
      bgColor: '#2d4a3e',
      defaultTool: 'chalk',
      textureStyle: 'chalk',
    },
  },
)

const minimalTitle = tmpl(
  'minimal-title',
  'Minimal Title',
  'Simple centered text with refined typography, no decoration',
  'title-card',
  ['title', 'minimal', 'simple'],
  { placeholders: ['TITLE'], duration: 5 },
)

// ── Diagrams ─────────────────────────────────────────────────

const flow3Step = tmpl(
  'flow-3step',
  '3-Step Flow',
  'Three boxes connected by arrows — show a linear process',
  'diagram',
  ['flow', 'process', 'arrows', 'steps'],
  { placeholders: ['STEP1', 'STEP2', 'STEP3'], duration: 10 },
)

const networkNodes = tmpl(
  'network-nodes',
  'Network Diagram',
  'Central node with 4 connected satellite nodes',
  'diagram',
  ['network', 'hub', 'connections', 'nodes'],
  { placeholders: ['CENTER', 'NODE1', 'NODE2', 'NODE3', 'NODE4'], duration: 10 },
)

const beforeAfter = tmpl(
  'before-after',
  'Before / After',
  'Split canvas showing two contrasting states side by side',
  'comparison',
  ['comparison', 'before', 'after', 'split'],
  { placeholders: ['BEFORE_TITLE', 'AFTER_TITLE', 'BEFORE_BODY', 'AFTER_BODY'], duration: 10 },
)

const pyramid = tmpl(
  'pyramid',
  'Hierarchy Pyramid',
  'Three-level pyramid showing hierarchy or priority',
  'diagram',
  ['pyramid', 'hierarchy', 'levels'],
  { placeholders: ['TOP', 'MIDDLE', 'BOTTOM'], duration: 10 },
)

// ── Data ─────────────────────────────────────────────────────

const barChart = tmpl(
  'bar-chart',
  'Bar Chart',
  'Animated D3 bar chart — provide data values and labels',
  'data',
  ['chart', 'bar', 'd3', 'data'],
  { placeholders: ['TITLE', 'DATA'], duration: 8 },
)

const lineTrend = tmpl(
  'line-trend',
  'Line Chart',
  'D3 line chart showing growth or trend over time',
  'data',
  ['chart', 'line', 'd3', 'trend', 'growth'],
  { placeholders: ['TITLE', 'DATA'], duration: 8 },
)

const statTrio = tmpl(
  'stat-trio',
  'Stat Trio',
  'Three large animated numbers with labels — key metrics',
  'data',
  ['stats', 'numbers', 'metrics', 'kpi'],
  { placeholders: ['STAT1', 'LABEL1', 'STAT2', 'LABEL2', 'STAT3', 'LABEL3'], duration: 8 },
)

// ── Process ──────────────────────────────────────────────────

const numberedSteps = tmpl(
  'numbered-steps',
  'Numbered Steps',
  'Vertical 1-2-3-4 list with animated reveal',
  'process',
  ['steps', 'list', 'numbered', 'sequence'],
  { placeholders: ['STEP1', 'STEP2', 'STEP3', 'STEP4'], duration: 10 },
)

const timeline = tmpl(
  'timeline',
  'Timeline',
  'Horizontal timeline with event markers and labels',
  'process',
  ['timeline', 'events', 'chronological'],
  { placeholders: ['EVENT1', 'EVENT2', 'EVENT3', 'EVENT4'], duration: 10 },
)

const checklist = tmpl(
  'checklist',
  'Animated Checklist',
  'Items appear one by one with animated checkmarks',
  'process',
  ['checklist', 'tasks', 'checkmark', 'list'],
  { placeholders: ['ITEM1', 'ITEM2', 'ITEM3', 'ITEM4'], duration: 10 },
)

// ── Quotes / Text ────────────────────────────────────────────

const pullQuote = tmpl(
  'pull-quote',
  'Pull Quote',
  'Large quote text with attribution — editorial style',
  'quote',
  ['quote', 'text', 'editorial'],
  { placeholders: ['QUOTE', 'AUTHOR'], duration: 8 },
)

const twoColumn = tmpl(
  'two-column',
  'Two Column',
  'Two text columns with a central divider',
  'quote',
  ['text', 'columns', 'compare', 'side-by-side'],
  { placeholders: ['LEFT_TITLE', 'LEFT_BODY', 'RIGHT_TITLE', 'RIGHT_BODY'], duration: 10 },
)

// ── Transitions ──────────────────────────────────────────────

const sectionBump = tmpl(
  'section-bump',
  'Section Divider',
  '"Part 2" style section bumper with number and title',
  'transition',
  ['transition', 'section', 'divider', 'bumper'],
  { placeholders: ['SECTION_NUMBER', 'SECTION_TITLE'], duration: 4 },
)

const countdown = tmpl(
  'countdown',
  'Countdown',
  'Animated 3-2-1 number countdown',
  'transition',
  ['countdown', 'numbers', 'transition'],
  { placeholders: [], duration: 4 },
)

// ── Special ──────────────────────────────────────────────────

const splitAvatar = tmpl(
  'split-avatar',
  'Avatar + Content',
  'Left side for avatar/speaker, right side for content',
  'technical',
  ['avatar', 'presenter', 'split', 'speaker'],
  { placeholders: ['TITLE', 'BODY'], duration: 10 },
)

const codeSnippet = tmpl(
  'code-snippet',
  'Code Snippet',
  'Dark background with monospace code block and syntax highlighting',
  'technical',
  ['code', 'technical', 'programming', 'snippet'],
  {
    placeholders: ['CODE', 'LANGUAGE', 'CAPTION'],
    duration: 8,
    styleOverride: { bgColor: '#0d1117', font: 'monospace' },
  },
)

// ── Interactive ─────────────────────────────────────────────

const interactiveDecision = tmpl(
  'interactive-decision',
  'Decision Branch',
  'Full-screen choice with 2-3 options — each jumps to a different scene',
  'interactive',
  ['choice', 'branch', 'decision', 'interactive'],
  {
    placeholders: ['QUESTION', 'OPTION_A', 'OPTION_B', 'OPTION_C'],
    duration: 10,
    interactions: [
      {
        type: 'choice',
        x: 20,
        y: 30,
        width: 60,
        height: 40,
        appearsAt: 2,
        hidesAt: null,
        entranceAnimation: 'slide-up',
        question: '${QUESTION}',
        layout: 'vertical' as const,
        options: [
          { id: 'opt-a', label: '${OPTION_A}', icon: null, jumpsToSceneId: '', color: null },
          { id: 'opt-b', label: '${OPTION_B}', icon: null, jumpsToSceneId: '', color: null },
          { id: 'opt-c', label: '${OPTION_C}', icon: null, jumpsToSceneId: '', color: null },
        ],
      },
    ],
  },
)

const interactiveQuiz = tmpl(
  'interactive-quiz',
  'Knowledge Check',
  'Quiz with 4 options — validates correct answer with explanation',
  'interactive',
  ['quiz', 'question', 'test', 'interactive'],
  {
    placeholders: ['QUESTION', 'OPT_1', 'OPT_2', 'OPT_3', 'OPT_4', 'EXPLANATION'],
    duration: 15,
    interactions: [
      {
        type: 'quiz',
        x: 25,
        y: 20,
        width: 50,
        height: 60,
        appearsAt: 1,
        hidesAt: null,
        entranceAnimation: 'fade',
        question: '${QUESTION}',
        options: [
          { id: 'q1', label: '${OPT_1}' },
          { id: 'q2', label: '${OPT_2}' },
          { id: 'q3', label: '${OPT_3}' },
          { id: 'q4', label: '${OPT_4}' },
        ],
        correctOptionId: 'q1',
        onCorrect: 'continue' as const,
        onCorrectSceneId: null,
        onWrong: 'retry' as const,
        onWrongSceneId: null,
        explanation: '${EXPLANATION}',
      },
    ],
  },
)

const interactiveGate = tmpl(
  'interactive-gate',
  'Checkpoint Gate',
  'Pause point — scene freezes until viewer clicks to continue',
  'interactive',
  ['gate', 'pause', 'checkpoint', 'interactive'],
  {
    placeholders: ['BUTTON_TEXT'],
    duration: 10,
    interactions: [
      {
        type: 'gate',
        x: 35,
        y: 40,
        width: 30,
        height: 20,
        appearsAt: 5,
        hidesAt: null,
        entranceAnimation: 'pop',
        buttonLabel: '${BUTTON_TEXT}',
        buttonStyle: 'primary' as const,
        minimumWatchTime: 0,
      },
    ],
  },
)

const interactiveHotspotExplore = tmpl(
  'interactive-hotspot-explore',
  'Hotspot Explorer',
  '4 clickable hotspot areas — great for labeling diagram regions',
  'interactive',
  ['hotspot', 'explore', 'diagram', 'clickable', 'interactive'],
  {
    placeholders: ['LABEL_1', 'LABEL_2', 'LABEL_3', 'LABEL_4'],
    duration: 15,
    interactions: [
      {
        type: 'hotspot',
        x: 15,
        y: 20,
        width: 15,
        height: 15,
        appearsAt: 1,
        hidesAt: null,
        entranceAnimation: 'fade',
        label: '${LABEL_1}',
        shape: 'circle' as const,
        style: 'pulse' as const,
        color: '#f59e0b',
        triggersEdgeId: null,
        jumpsToSceneId: null,
      },
      {
        type: 'hotspot',
        x: 60,
        y: 20,
        width: 15,
        height: 15,
        appearsAt: 1.5,
        hidesAt: null,
        entranceAnimation: 'fade',
        label: '${LABEL_2}',
        shape: 'circle' as const,
        style: 'pulse' as const,
        color: '#3b82f6',
        triggersEdgeId: null,
        jumpsToSceneId: null,
      },
      {
        type: 'hotspot',
        x: 15,
        y: 60,
        width: 15,
        height: 15,
        appearsAt: 2,
        hidesAt: null,
        entranceAnimation: 'fade',
        label: '${LABEL_3}',
        shape: 'circle' as const,
        style: 'pulse' as const,
        color: '#10b981',
        triggersEdgeId: null,
        jumpsToSceneId: null,
      },
      {
        type: 'hotspot',
        x: 60,
        y: 60,
        width: 15,
        height: 15,
        appearsAt: 2.5,
        hidesAt: null,
        entranceAnimation: 'fade',
        label: '${LABEL_4}',
        shape: 'circle' as const,
        style: 'pulse' as const,
        color: '#8b5cf6',
        triggersEdgeId: null,
        jumpsToSceneId: null,
      },
    ],
  },
)

const interactiveFormCollect = tmpl(
  'interactive-form-collect',
  'Input Form',
  'Collects user input into variables for personalization in later scenes',
  'interactive',
  ['form', 'input', 'personalize', 'variables', 'interactive'],
  {
    placeholders: ['FORM_TITLE', 'FIELD_1_LABEL', 'FIELD_2_LABEL'],
    duration: 20,
    interactions: [
      {
        type: 'form',
        x: 25,
        y: 20,
        width: 50,
        height: 60,
        appearsAt: 1,
        hidesAt: null,
        entranceAnimation: 'slide-up',
        fields: [
          {
            id: 'f1',
            label: '${FIELD_1_LABEL}',
            type: 'text' as const,
            placeholder: 'Type here...',
            options: [],
            required: true,
          },
          {
            id: 'f2',
            label: '${FIELD_2_LABEL}',
            type: 'text' as const,
            placeholder: 'Type here...',
            options: [],
            required: false,
          },
        ],
        submitLabel: 'Continue',
        setsVariables: [
          { fieldId: 'f1', variableName: 'field1' },
          { fieldId: 'f2', variableName: 'field2' },
        ],
        jumpsToSceneId: null,
      },
    ],
  },
)

const interactiveTooltipGrid = tmpl(
  'interactive-tooltip-grid',
  'Tooltip Explainer',
  '4 hover-triggered tooltips — great for labeling parts of a diagram',
  'interactive',
  ['tooltip', 'hover', 'explain', 'label', 'interactive'],
  {
    placeholders: [
      'TIP_1_TITLE',
      'TIP_1_BODY',
      'TIP_2_TITLE',
      'TIP_2_BODY',
      'TIP_3_TITLE',
      'TIP_3_BODY',
      'TIP_4_TITLE',
      'TIP_4_BODY',
    ],
    duration: 15,
    interactions: [
      {
        type: 'tooltip',
        x: 20,
        y: 25,
        width: 5,
        height: 5,
        appearsAt: 1,
        hidesAt: null,
        entranceAnimation: 'fade',
        triggerShape: 'circle' as const,
        triggerColor: '#3b82f6',
        triggerLabel: '1',
        tooltipTitle: '${TIP_1_TITLE}',
        tooltipBody: '${TIP_1_BODY}',
        tooltipPosition: 'right' as const,
        tooltipMaxWidth: 240,
      },
      {
        type: 'tooltip',
        x: 65,
        y: 25,
        width: 5,
        height: 5,
        appearsAt: 1.5,
        hidesAt: null,
        entranceAnimation: 'fade',
        triggerShape: 'circle' as const,
        triggerColor: '#10b981',
        triggerLabel: '2',
        tooltipTitle: '${TIP_2_TITLE}',
        tooltipBody: '${TIP_2_BODY}',
        tooltipPosition: 'left' as const,
        tooltipMaxWidth: 240,
      },
      {
        type: 'tooltip',
        x: 20,
        y: 65,
        width: 5,
        height: 5,
        appearsAt: 2,
        hidesAt: null,
        entranceAnimation: 'fade',
        triggerShape: 'circle' as const,
        triggerColor: '#f59e0b',
        triggerLabel: '3',
        tooltipTitle: '${TIP_3_TITLE}',
        tooltipBody: '${TIP_3_BODY}',
        tooltipPosition: 'right' as const,
        tooltipMaxWidth: 240,
      },
      {
        type: 'tooltip',
        x: 65,
        y: 65,
        width: 5,
        height: 5,
        appearsAt: 2.5,
        hidesAt: null,
        entranceAnimation: 'fade',
        triggerShape: 'circle' as const,
        triggerColor: '#ec4899',
        triggerLabel: '4',
        tooltipTitle: '${TIP_4_TITLE}',
        tooltipBody: '${TIP_4_BODY}',
        tooltipPosition: 'left' as const,
        tooltipMaxWidth: 240,
      },
    ],
  },
)

const interactiveTrueFalse = tmpl(
  'interactive-true-false',
  'True or False',
  'Simple statement with True/False options and immediate feedback',
  'interactive',
  ['quiz', 'true', 'false', 'simple', 'interactive'],
  {
    placeholders: ['STATEMENT', 'EXPLANATION'],
    duration: 12,
    interactions: [
      {
        type: 'quiz',
        x: 25,
        y: 25,
        width: 50,
        height: 50,
        appearsAt: 2,
        hidesAt: null,
        entranceAnimation: 'pop',
        question: '${STATEMENT}',
        options: [
          { id: 'true', label: 'True' },
          { id: 'false', label: 'False' },
        ],
        correctOptionId: 'true',
        onCorrect: 'continue' as const,
        onCorrectSceneId: null,
        onWrong: 'retry' as const,
        onWrongSceneId: null,
        explanation: '${EXPLANATION}',
      },
    ],
  },
)

const interactiveSurvey = tmpl(
  'interactive-survey',
  'Survey',
  'Multi-field form with radio, dropdown, and text for collecting viewer feedback',
  'interactive',
  ['survey', 'feedback', 'form', 'poll', 'interactive'],
  {
    placeholders: ['SURVEY_TITLE', 'Q1', 'Q2', 'Q3'],
    duration: 30,
    interactions: [
      {
        type: 'form',
        x: 20,
        y: 10,
        width: 60,
        height: 80,
        appearsAt: 1,
        hidesAt: null,
        entranceAnimation: 'slide-up',
        fields: [
          {
            id: 's1',
            label: '${Q1}',
            type: 'radio' as const,
            placeholder: null,
            options: ['Strongly agree', 'Agree', 'Neutral', 'Disagree'],
            required: true,
          },
          {
            id: 's2',
            label: '${Q2}',
            type: 'select' as const,
            placeholder: null,
            options: ['Option A', 'Option B', 'Option C'],
            required: true,
          },
          {
            id: 's3',
            label: '${Q3}',
            type: 'text' as const,
            placeholder: 'Your thoughts...',
            options: [],
            required: false,
          },
        ],
        submitLabel: 'Submit',
        setsVariables: [
          { fieldId: 's1', variableName: 'survey_q1' },
          { fieldId: 's2', variableName: 'survey_q2' },
          { fieldId: 's3', variableName: 'survey_q3' },
        ],
        jumpsToSceneId: null,
      },
    ],
  },
)

const interactiveStoryBranch = tmpl(
  'interactive-story-branch',
  'Story Branch',
  'Narrative scene with two choice buttons at the bottom — "What happens next?"',
  'interactive',
  ['story', 'narrative', 'branch', 'adventure', 'interactive'],
  {
    placeholders: ['NARRATIVE', 'CHOICE_A', 'CHOICE_B'],
    duration: 12,
    interactions: [
      {
        type: 'choice',
        x: 10,
        y: 70,
        width: 80,
        height: 20,
        appearsAt: 4,
        hidesAt: null,
        entranceAnimation: 'slide-up',
        question: null,
        layout: 'horizontal' as const,
        options: [
          { id: 'a', label: '${CHOICE_A}', icon: null, jumpsToSceneId: '', color: null },
          { id: 'b', label: '${CHOICE_B}', icon: null, jumpsToSceneId: '', color: null },
        ],
      },
    ],
  },
)

const interactiveReveal = tmpl(
  'interactive-reveal',
  'Reveal Gate',
  'Content hidden behind a "Click to reveal" button — progressive disclosure',
  'interactive',
  ['reveal', 'gate', 'hidden', 'disclosure', 'interactive'],
  {
    placeholders: ['REVEAL_BUTTON_TEXT'],
    duration: 12,
    interactions: [
      {
        type: 'gate',
        x: 30,
        y: 35,
        width: 40,
        height: 30,
        appearsAt: 4.8,
        hidesAt: null,
        entranceAnimation: 'pop',
        buttonLabel: '${REVEAL_BUTTON_TEXT}',
        buttonStyle: 'primary' as const,
        minimumWatchTime: 2,
      },
    ],
  },
)

/** All built-in templates */
export const BUILT_IN_TEMPLATES: SceneTemplate[] = [
  cleanTitle,
  boldTitle,
  chalkboardTitle,
  minimalTitle,
  flow3Step,
  networkNodes,
  beforeAfter,
  pyramid,
  barChart,
  lineTrend,
  statTrio,
  numberedSteps,
  timeline,
  checklist,
  pullQuote,
  twoColumn,
  sectionBump,
  countdown,
  splitAvatar,
  codeSnippet,
  // Interactive
  interactiveDecision,
  interactiveQuiz,
  interactiveGate,
  interactiveHotspotExplore,
  interactiveFormCollect,
  interactiveTooltipGrid,
  interactiveTrueFalse,
  interactiveSurvey,
  interactiveStoryBranch,
  interactiveReveal,
]

/** Look up a built-in template by ID */
export function getBuiltInTemplate(id: string): SceneTemplate | undefined {
  return BUILT_IN_TEMPLATES.find((t) => t.id === id)
}

/**
 * Does this template instantiate into anything?
 *
 * Deliberately checks `interactions` ONLY, because that is the only thing
 * `instantiateTemplate` actually carries onto a Scene. `SceneTemplate.layers`
 * is vestigial: `Scene` has no `layers` field (it has aiLayers / svgObjects /
 * reactCode), so the template layer model predates the current Scene shape and
 * has no home on it. Testing `t.layers.length` here would be worse than
 * useless — it would green-light a template that still instantiates empty.
 *
 * As it stands `tmpl()` defaults layers to `[]` and no built-in overrides it,
 * so twenty of the thirty declared built-ins — every non-interactive one —
 * carry no content at all and instantiate into a scene with no layers, no
 * code, and empty HTML. Offering those ids produced a blank scene reported as
 * a success.
 */
export function templateHasContent(t: SceneTemplate): boolean {
  return (t.interactions?.length ?? 0) > 0
}

/**
 * The ids `use_template` may actually be offered. Derived rather than
 * hand-listed so it cannot drift as templates gain or lose content — a
 * hand-maintained list next to the data it describes is what made three rule
 * packs unreachable in this codebase already.
 */
export const INSTANTIABLE_TEMPLATE_IDS: string[] = BUILT_IN_TEMPLATES.filter(templateHasContent).map((t) => t.id)
