import { describe, expect, it } from 'vitest';
import { parseDispatchURL } from '../src/url-scheme.js';

describe('parseDispatchURL', () => {
  it('returns workstream id for a well-formed URL', () => {
    expect(parseDispatchURL('dispatch://workstream/frontend-refactor')).toEqual({
      kind: 'workstream',
      id: 'frontend-refactor',
    });
  });

  it('rejects when slug is missing', () => {
    expect(parseDispatchURL('dispatch://workstream/')).toBeNull();
    expect(parseDispatchURL('dispatch://workstream')).toBeNull();
  });

  it('rejects wrong scheme', () => {
    expect(parseDispatchURL('http://workstream/abc')).toBeNull();
    expect(parseDispatchURL('manager://workstream/abc')).toBeNull();
  });

  it('rejects wrong host', () => {
    expect(parseDispatchURL('dispatch://decision/abc')).toBeNull();
    expect(parseDispatchURL('dispatch://abc')).toBeNull();
  });

  it('rejects path traversal in the slug', () => {
    expect(parseDispatchURL('dispatch://workstream/..')).toBeNull();
    expect(parseDispatchURL('dispatch://workstream/../etc')).toBeNull();
    expect(parseDispatchURL('dispatch://workstream/foo/bar')).toBeNull();
  });

  it('ignores query strings', () => {
    expect(parseDispatchURL('dispatch://workstream/abc?ref=help')).toEqual({
      kind: 'workstream',
      id: 'abc',
    });
  });

  it('tolerates a single trailing slash', () => {
    expect(parseDispatchURL('dispatch://workstream/abc/')).toEqual({
      kind: 'workstream',
      id: 'abc',
    });
  });

  it('rejects slugs with capital letters', () => {
    expect(parseDispatchURL('dispatch://workstream/AbC')).toBeNull();
    expect(parseDispatchURL('dispatch://workstream/Abc')).toBeNull();
  });
});
