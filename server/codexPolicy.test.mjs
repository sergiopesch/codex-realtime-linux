import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GENERATED_ARTIFACT_DIR,
  artifactPlanForGoal,
  buildWorkspaceGuard,
  goalWithWorkspaceGuard,
  hasExplicitAppEditIntent,
  isArtifactRequest,
} from './codexPolicy.mjs'

test('classifies generated HTML requests as artifact work', () => {
  assert.equal(
    isArtifactRequest('Create a simple index.html that outlines what the project is about.'),
    true,
  )
  assert.equal(isArtifactRequest('Can you put together a slideshow from the images in this workspace?'), true)
  assert.equal(isArtifactRequest('Design a browser preview deck about the attached screenshots.'), true)
  assert.equal(isArtifactRequest('Produce a microsite report from these project files.'), true)
  assert.equal(isArtifactRequest('Prepare an interactive gallery from the images in this workspace.'), true)
  assert.equal(isArtifactRequest('Compose a one-pager explainer from these notes.'), true)
  assert.equal(isArtifactRequest('Assemble a clickable portfolio site from the screenshots.'), true)
  assert.equal(isArtifactRequest('Fix the USB watcher bug in the app.'), false)
  assert.equal(isArtifactRequest('Fix the file watcher bug in the app.'), false)
})

test('detects explicit app edit intent separately from artifact creation', () => {
  assert.equal(hasExplicitAppEditIntent('Create a simple index.html about the project.'), false)
  assert.equal(hasExplicitAppEditIntent('Edit this app and change the React UI source.'), true)
})

test('guard routes generic file creation away from protected app source', () => {
  const plan = artifactPlanForGoal('Create a simple index.html about this project.', new Date('2026-06-08T20:00:00Z'))
  const guarded = goalWithWorkspaceGuard('Create a simple index.html about this project.', plan)

  assert.equal(plan?.relativePath, `${GENERATED_ARTIFACT_DIR}/20260608t200000-create-a-simple-index-html-about-this-project/index.html`)
  assert.match(guarded, new RegExp(`${GENERATED_ARTIFACT_DIR}/`))
  assert.match(guarded, /Protected app source paths:/)
  assert.match(guarded, /Never turn it into a standalone content page/)
  assert.match(guarded, /directly viewable in an iframe/)
  assert.match(guarded, /User goal:\nCreate a simple index\.html/)
})

test('artifact plans accept a bounded unique suffix for runtime folders', () => {
  const plan = artifactPlanForGoal(
    'Create a simple index.html about this project.',
    new Date('2026-06-08T20:00:00Z'),
    'abcdef12-extra-suffix-that-should-be-bounded',
  )

  assert.equal(
    plan?.relativePath,
    `${GENERATED_ARTIFACT_DIR}/20260608t200000-create-a-simple-index-html-about-this-project-abcdef12-extra-s/index.html`,
  )
})

test('guard still protects app shell when app edits are explicit', () => {
  const guarded = buildWorkspaceGuard('Edit this app and change src/App.tsx.')

  assert.match(guarded, /Protected app source paths:/)
  assert.doesNotMatch(guarded, new RegExp(`${GENERATED_ARTIFACT_DIR}/`))
})
