import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bookViews, navigationTarget, needsBook, viewFromPath} from '../src/navigation.js';

test('every sidebar view has a destination without requiring an existing book', () => {
  for (const view of [...bookViews, 'authors', 'settings'] as const) {
    const path = navigationTarget(view, '', []);
    assert.equal(viewFromPath(path), view);
    assert.ok(path);
  }
});
test('navigation preserves the view as projects load and never reuses a stale selection', () => {
  for (const view of bookViews) {
    assert.equal(navigationTarget(view, 'missing', ['one', 'two']), `/books/one/${view}`);
    assert.equal(navigationTarget(view, 'two', ['one', 'two']), `/books/two/${view}`);
    assert.equal(viewFromPath(`/books/two/${view}`), view);
  }
  assert.equal(navigationTarget('authors', 'two', ['two']), '/authors');
  assert.equal(navigationTarget('settings', 'two', ['two']), '/settings');
});
test('global pages and contextual empty pages have explicit selection requirements', () => {
  for (const view of ['overview', 'authors', 'settings', 'fanqie'] as const) assert.equal(needsBook(view), false);
  for (const view of ['planning', 'workflow', 'workspace', 'book-settings'] as const) assert.equal(needsBook(view), true);
  assert.equal(viewFromPath('/authors/demo/versions'), 'authors');
  assert.equal(viewFromPath('/settings/'), 'settings');
  assert.equal(viewFromPath('/unknown'), 'overview');
});
