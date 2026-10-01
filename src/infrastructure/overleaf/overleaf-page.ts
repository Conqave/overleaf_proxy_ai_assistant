import { NamedError } from '../../domain/errors';

export interface OverleafPageIdentity {
  readonly userId: string;
  readonly projectId: string;
}

export class MissingPageIdentityError extends NamedError {
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

function getMetaContent(document: Document, name: string): string {
  const meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta || meta.content === '') throw new MissingPageIdentityError(name);
  return meta.content;
}
