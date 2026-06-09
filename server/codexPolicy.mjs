export const GENERATED_ARTIFACT_DIR = 'public/agent-files'

export const PROTECTED_APP_PATHS = [
  'index.html',
  'src/**',
  'electron/**',
  'server/**',
  'scripts/**',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'tsconfig*.json',
  'eslint.config.js',
  '.env*',
]

const ARTIFACT_ACTION_TERMS = [
  'add',
  'assemble',
  'build',
  'compose',
  'create',
  'design',
  'draft',
  'generate',
  'make',
  'prepare',
  'produce',
  'put together',
  'write',
]

const ARTIFACT_OUTPUT_TERMS = [
  'article',
  'browser preview',
  'clickable',
  'deck',
  'demo',
  'document',
  'explainer',
  'file',
  'gallery',
  'html',
  'index.html',
  'infographic',
  'interactive',
  'landing page',
  'microsite',
  'one pager',
  'one-pager',
  'page',
  'portfolio',
  'poster',
  'presentation',
  'report',
  'site',
  'slide',
  'slides',
  'slideshow',
  'story',
  'web page',
  'web app',
  'webpage',
  'website',
]

const STRONG_ARTIFACT_OUTPUT_TERMS = [
  'browser preview',
  'clickable',
  'deck',
  'gallery',
  'html',
  'index.html',
  'infographic',
  'interactive',
  'landing page',
  'microsite',
  'one pager',
  'one-pager',
  'portfolio',
  'poster',
  'presentation',
  'report',
  'site',
  'slide',
  'slides',
  'slideshow',
  'web page',
  'web app',
  'webpage',
  'website',
]

const ARTIFACT_NOUN_QUALIFIERS = [
  'beautiful',
  'browser',
  'clean',
  'clickable',
  'html',
  'interactive',
  'modern',
  'polished',
  'quick',
  'short',
  'simple',
  'visual',
  'web',
]

const EXPLICIT_APP_EDIT_PATTERN =
  /\b(edit|change|modify|update|fix|refactor|redesign|alter|touch)\b[\s\S]{0,100}\b(app source|application source|app shell|this app|the app|ui source|electron app|react app|src\/|server\/|electron\/|index\.html)\b/i

const EXPLICIT_APP_CREATION_PATTERN =
  /\b(add|build|create|make|implement|develop)\b[\s\S]{0,120}\b(to|in|inside|within|into)\s+(this app|the app|the electron app|the react app|codex realtime linux)\b/i

const DESIRED_ARTIFACT_PATTERN =
  /\b(i\s+need|i\s+want|i\s+would\s+like|we\s+need|we\s+want|let'?s\s+have|can\s+i\s+have|please\s+give\s+me)\b/i

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const termPattern = (term) => escapeRegExp(term).replace(/\s+/g, '\\s+')

const strongArtifactOutputPattern = STRONG_ARTIFACT_OUTPUT_TERMS
  .slice()
  .sort((a, b) => b.length - a.length)
  .map(termPattern)
  .join('|')

const artifactNounQualifiersPattern = ARTIFACT_NOUN_QUALIFIERS.map(termPattern).join('|')

const ARTIFACT_NOUN_REQUEST_PATTERN = new RegExp(
  `^(?:please\\s+)?(?:(?:a|an|the|this|that|my|our)\\s+)?(?:(?:${artifactNounQualifiersPattern})\\s+){0,5}(?:${strongArtifactOutputPattern})\\b[\\s\\S]{0,140}\\b(?:about|from|for|using|with|based\\s+on|in\\s+the\\s+style\\s+of|that\\s+(?:uses|includes|shows|summarizes)|showing|summarizing)\\b`,
  'i',
)

const containsTerm = (value, terms) => terms.some((term) => new RegExp(`\\b${termPattern(term)}\\b`, 'i').test(value))

const slug = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 52) || 'artifact'

export function isArtifactRequest(goal) {
  const explicitCreation = containsTerm(goal, ARTIFACT_ACTION_TERMS) && containsTerm(goal, ARTIFACT_OUTPUT_TERMS)
  const desiredArtifact = DESIRED_ARTIFACT_PATTERN.test(goal) && containsTerm(goal, STRONG_ARTIFACT_OUTPUT_TERMS)
  const nounPhraseArtifact = ARTIFACT_NOUN_REQUEST_PATTERN.test(goal)
  return explicitCreation || desiredArtifact || nounPhraseArtifact
}

export function hasExplicitAppEditIntent(goal) {
  return EXPLICIT_APP_EDIT_PATTERN.test(goal) || EXPLICIT_APP_CREATION_PATTERN.test(goal)
}

export function artifactPlanForGoal(goal, date = new Date(), uniqueSuffix = '') {
  if (!isArtifactRequest(goal) || hasExplicitAppEditIntent(goal)) return null
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').toLowerCase()
  const suffix = typeof uniqueSuffix === 'string' && uniqueSuffix.trim() ? slug(uniqueSuffix).slice(0, 16) : ''
  const directoryName = `${stamp}-${slug(goal)}${suffix ? `-${suffix}` : ''}`
  return {
    directoryName,
    relativeDir: `${GENERATED_ARTIFACT_DIR}/${directoryName}`,
    relativePath: `${GENERATED_ARTIFACT_DIR}/${directoryName}/index.html`,
  }
}

export function buildWorkspaceGuard(goal, artifactPlan = artifactPlanForGoal(goal)) {
  const lines = [
    'Important workspace guardrail: this repo is the Codex Realtime Linux app itself.',
    `Protected app source paths: ${PROTECTED_APP_PATHS.join(', ')}.`,
    'Do not edit protected app source paths unless the user explicitly asks to modify this app or a specific protected file.',
    'The root index.html is only the Vite React mount shell. Never turn it into a standalone content page, never put fallback content inside #root, and never add global inline CSS to index.html.',
  ]

  if (artifactPlan) {
    lines.push(
      `This request looks like an artifact/file creation task, not an app-source edit. Create the result at ${artifactPlan.relativePath}.`,
      `Keep all supporting files for this result inside ${artifactPlan.relativeDir}/.`,
      'If the user asks for index.html without explicitly asking to change this app, use the artifact path above instead of editing the root index.html.',
      'The result should be directly viewable in an iframe/browser preview from that index.html file.',
    )
  }

  return lines.join(' ')
}

export function goalWithWorkspaceGuard(goal, artifactPlan = artifactPlanForGoal(goal)) {
  return `${buildWorkspaceGuard(goal, artifactPlan)}\n\nUser goal:\n${goal}`
}
