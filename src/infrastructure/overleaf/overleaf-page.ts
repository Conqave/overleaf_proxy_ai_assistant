import { NamedError } from '../../domain/errors';

interface OverleafPageIdentity {
  readonly userId: string;
  readonly projectId: string;
}

export class MissingPageMetadataError extends NamedError {
  constructor(meta: string) {
    super(`The Overleaf page has no ${meta} metadata.`);
  }
}

export function getPageIdentity(document: Document): OverleafPageIdentity {
  return {
    userId: getMetaContent(document, 'ol-user_id'),
    projectId: getMetaContent(document, 'ol-project_id'),
  };
}

export function getCsrfToken(document: Document): string {
  return getMetaContent(document, 'ol-csrfToken');
}

function getMetaContent(document: Document, name: string): string {
  const meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta || meta.content === '') throw new MissingPageMetadataError(name);
  return meta.content;
}
