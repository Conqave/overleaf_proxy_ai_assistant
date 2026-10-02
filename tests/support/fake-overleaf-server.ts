import type { FakeFolder } from './fake-overleaf';
import { TestFixtureError } from './test-errors';

export const FAKE_CSRF_TOKEN = 'csrf-1';

const FOLDER_URL = /^\/project\/([^/]+)\/folder$/;
const UPLOAD_URL = /^\/project\/([^/]+)\/upload\?folder_id=([^&]+)$/;
const FILE_URL = /^\/project\/([^/]+)\/file\/([^/]+)$/;
const DOC_URL = /^\/Project\/([^/]+)\/doc\/([^/]+)\/download$/;

export interface FakeDocuments {
  hasText(id: string): boolean;
  textOf(id: string): string;
}

interface StoredEntity {
  readonly id: string;
  readonly name: string;
  readonly folderId: string;
}

interface StoredFile extends StoredEntity {
  readonly text: string;
}

export interface ServerRequest {
  readonly method: string;
  readonly url: string;
}

export class FakeOverleafServer {
  readonly requests: ServerRequest[] = [];
  answersWith: ((request: ServerRequest) => Response | null) | null = null;
  private readonly folders = new Map<string, StoredEntity>();
  private readonly files = new Map<string, StoredFile>();
  private nextId = 1;

  constructor(
    rootFolder: FakeFolder,
    private readonly docs: FakeDocuments,
    texts: ReadonlyMap<string, string>,
  ) {
    this.addFolder(rootFolder, '', texts);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input !== 'string') throw new TestFixtureError('Overleaf is fetched by URL text');
    const request = { method: init?.method ?? 'GET', url: input };
    this.requests.push(request);
    const answer = this.answersWith?.(request) ?? null;
    if (answer !== null) return answer;
    const folder = FOLDER_URL.exec(input);
    if (folder !== null) return this.createFolder(init);
    const upload = UPLOAD_URL.exec(input);
    if (upload !== null) return await this.upload(decodeURIComponent(group(upload, 2)), init);
    const file = FILE_URL.exec(input);
    if (file !== null) return this.download(group(file, 2));
    const doc = DOC_URL.exec(input);
    if (doc !== null) return this.downloadDoc(group(doc, 2));
    throw new TestFixtureError(`the fake Overleaf server does not answer ${input}`);
  };

  textAt(path: string): string {
    const file = [...this.files.values()].find((stored) => this.pathOf(stored) === path);
    if (file === undefined) throw new TestFixtureError(`the project has no file ${path}`);
    return file.text;
  }

  paths(): string[] {
    return [...this.files.values()].map((file) => this.pathOf(file)).sort();
  }

  removeFolder(path: string): void {
    const folder = [...this.folders.values()].find((entity) => this.pathOf(entity) === path);
    if (folder === undefined) throw new TestFixtureError(`the fake project has no folder ${path}`);
    this.folders.delete(folder.id);
    for (const [id, file] of this.files) if (file.folderId === folder.id) this.files.delete(id);
  }

  private addFolder(folder: FakeFolder, parentId: string, texts: ReadonlyMap<string, string>) {
    this.folders.set(folder._id, { id: folder._id, name: folder.name, folderId: parentId });
    for (const fileRef of folder.fileRefs) {
      const text = texts.get(fileRef._id);
      if (text === undefined) throw new TestFixtureError(`no fixture text for ${fileRef._id}`);
      this.files.set(fileRef._id, {
        id: fileRef._id,
        name: fileRef.name,
        folderId: folder._id,
        text,
      });
    }
    for (const child of folder.folders) this.addFolder(child, folder._id, texts);
  }

  private createFolder(init: RequestInit | undefined): Response {
    if (!this.isAuthorized(init)) return new Response('Forbidden', { status: 403 });
    if (typeof init?.body !== 'string') throw new TestFixtureError('folders are created by JSON');
    const body: unknown = JSON.parse(init.body);
    if (
      typeof body !== 'object' ||
      body === null ||
      !('name' in body && typeof body.name === 'string') ||
      !('parent_folder_id' in body && typeof body.parent_folder_id === 'string')
    ) {
      throw new TestFixtureError('a folder needs a name and a parent_folder_id');
    }
    if (!this.folders.has(body.parent_folder_id)) return new Response('', { status: 404 });
    if (this.hasEntity(body.parent_folder_id, body.name)) {
      return new Response('File already exists', { status: 400 });
    }
    const id = this.createId('folder');
    this.folders.set(id, { id, name: body.name, folderId: body.parent_folder_id });
    return Response.json({ name: body.name, _id: id, docs: [], fileRefs: [], folders: [] });
  }

  private async upload(folderId: string, init: RequestInit | undefined): Promise<Response> {
    if (!this.isAuthorized(init)) return new Response('Forbidden', { status: 403 });
    const form = init?.body;
    if (!(form instanceof FormData)) throw new TestFixtureError('files are uploaded as a form');
    const name = form.get('name');
    const content = form.get('qqfile');
    if (typeof name !== 'string' || !(content instanceof Blob)) {
      throw new TestFixtureError('an upload needs a name and a qqfile');
    }
    if (!this.folders.has(folderId)) return Response.json({ success: false }, { status: 404 });
    for (const [id, file] of this.files) {
      if (file.folderId === folderId && file.name === name) this.files.delete(id);
    }
    const id = this.createId('file');
    this.files.set(id, { id, name, folderId, text: await content.text() });
    return Response.json({ success: true, entity_id: id, entity_type: 'file' });
  }

  private download(id: string): Response {
    const file = this.files.get(id);
    if (file === undefined) return new Response('Not found', { status: 404 });
    return new Response(file.text);
  }

  private downloadDoc(id: string): Response {
    if (!this.docs.hasText(id)) return new Response('Not found', { status: 404 });
    return new Response(this.docs.textOf(id));
  }

  private hasEntity(folderId: string, name: string): boolean {
    return [...this.folders.values(), ...this.files.values()].some(
      (entity) => entity.folderId === folderId && entity.name === name,
    );
  }

  private isAuthorized(init: RequestInit | undefined): boolean {
    return new Headers(init?.headers).get('X-Csrf-Token') === FAKE_CSRF_TOKEN;
  }

  private pathOf(entity: StoredEntity): string {
    const names = [entity.name];
    let folder = this.folders.get(entity.folderId);
    while (folder !== undefined && folder.folderId !== '') {
      names.unshift(folder.name);
      folder = this.folders.get(folder.folderId);
    }
    return names.join('/');
  }

  private createId(kind: string): string {
    const id = `${kind}-new-${String(this.nextId)}`;
    this.nextId += 1;
    return id;
  }
}

function group(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new TestFixtureError(`the URL has no group ${String(index)}`);
  return value;
}
