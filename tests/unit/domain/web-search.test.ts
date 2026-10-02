import { describe, expect, it } from 'vitest';
import { InvalidWebSearchResultError } from '../../../src/domain/errors';
import { createWebSearchResult } from '../../../src/domain/web-search';

const RESULT = { title: ' A book ', url: 'https://example.org/a?b=1#c', snippet: ' text \n' };

describe('createWebSearchResult', () => {
  it('keeps a result with trimmed title, snippet and date', () => {
    expect(createWebSearchResult({ ...RESULT, published: ' 1994 ' })).toEqual({
      title: 'A book',
      url: 'https://example.org/a?b=1#c',
      snippet: 'text',
      published: '1994',
    });
    expect(createWebSearchResult(RESULT)).not.toHaveProperty('published');
  });

  it.each([
    ['an empty title', { ...RESULT, title: ' ' }, 'has no title'],
    ['a relative address', { ...RESULT, url: '/a' }, 'not an absolute http or https address'],
    ['a script address', { ...RESULT, url: 'javascript:alert(1)' }, 'not an absolute http'],
    ['an address without host', { ...RESULT, url: 'https:///a' }, 'not an absolute http'],
    ['an address with spaces', { ...RESULT, url: 'https://a.org/x y' }, 'not an absolute http'],
    ['an empty date', { ...RESULT, published: ' ' }, 'empty publication date'],
  ])('rejects %s', (_name, input, problem) => {
    expect(() => createWebSearchResult(input)).toThrow(InvalidWebSearchResultError);
    expect(() => createWebSearchResult(input)).toThrow(problem);
  });
});
