import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  getCsrfToken,
  getPageIdentity,
  MissingPageMetadataError,
} from '../../../src/infrastructure/overleaf/overleaf-page';

const page = (head: string) => new JSDOM(`<!doctype html><head>${head}</head>`).window.document;
const USER = '<meta name="ol-user_id" content="u1">';
const PROJECT = '<meta name="ol-project_id" content="p1">';

describe('getPageIdentity', () => {
  it('reads the user and project Overleaf publishes on the editor page', () => {
    expect(getPageIdentity(page(USER + PROJECT))).toEqual({ userId: 'u1', projectId: 'p1' });
  });

  it('fails fast on a page that names no user or no project', () => {
    expect(() => getPageIdentity(page(PROJECT))).toThrow(MissingPageMetadataError);
    expect(() => getPageIdentity(page(USER))).toThrow(MissingPageMetadataError);
    expect(() => getPageIdentity(page(USER + '<meta name="ol-project_id" content="">'))).toThrow(
      MissingPageMetadataError,
    );
  });
});

describe('getCsrfToken', () => {
  it('reads the token Overleaf expects on every write request', () => {
    expect(getCsrfToken(page('<meta name="ol-csrfToken" content="t1">'))).toBe('t1');
    expect(() => getCsrfToken(page(USER))).toThrow(MissingPageMetadataError);
  });
});
