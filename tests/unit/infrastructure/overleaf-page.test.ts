import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  getPageIdentity,
  MissingPageIdentityError,
} from '../../../src/infrastructure/overleaf/overleaf-page';

const page = (head: string) => new JSDOM(`<!doctype html><head>${head}</head>`).window.document;
const USER = '<meta name="ol-user_id" content="u1">';
const PROJECT = '<meta name="ol-project_id" content="p1">';

describe('getPageIdentity', () => {
  it('reads the user and project Overleaf publishes on the editor page', () => {
    expect(getPageIdentity(page(USER + PROJECT))).toEqual({ userId: 'u1', projectId: 'p1' });
  });

  it('fails fast on a page that names no user or no project', () => {
    expect(() => getPageIdentity(page(PROJECT))).toThrow(MissingPageIdentityError);
    expect(() => getPageIdentity(page(USER))).toThrow(MissingPageIdentityError);
    expect(() => getPageIdentity(page(USER + '<meta name="ol-project_id" content="">'))).toThrow(
      MissingPageIdentityError,
    );
  });
});
