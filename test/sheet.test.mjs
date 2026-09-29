import test from 'node:test';
import assert from 'node:assert/strict';
import { swipeCloses } from '../pwa/js/ui/common.js';

test('sheets: a swipe down closes them once it goes far enough, or quickly enough', () => {
  assert.equal(swipeCloses(30, 600, 600), false, 'a small, slow pull snaps back');
  assert.equal(swipeCloses(150, 600, 600), true, 'far enough');
  assert.equal(swipeCloses(90, 600, 280), true, 'a short sheet needs a shorter swipe');
  assert.equal(swipeCloses(60, 80, 600), true, 'a quick flick');
  assert.equal(swipeCloses(30, 20, 600), false, 'too short, even when quick');
});
