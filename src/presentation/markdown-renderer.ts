import createDOMPurify, { type Config, type DOMPurify } from 'dompurify';
import { Marked, type Tokens } from 'marked';
import { InvariantViolation } from '../domain/errors';

const ALLOWED_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'br',
  'hr',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
];

const PLAIN_ATTR = ['title', 'start', 'align'];
const ALLOWED_ATTR = ['href', ...PLAIN_ATTR];

const ALLOWED_URI = /^(?:https?|mailto):/i;

const LINK_TARGET = '_blank';
const LINK_REL = 'noopener noreferrer';

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const SANITIZE: Config & { RETURN_DOM_FRAGMENT: true } = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP: ALLOWED_URI,
  ADD_URI_SAFE_ATTR: PLAIN_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
};

export class MarkdownRenderer {
  private readonly markdown = new Marked({
    gfm: true,
    breaks: true,
    renderer: {
      html: ({ text }: Tokens.HTML | Tokens.Tag): string => escapeHtml(text),
      image: ({ text }: Tokens.Image): string => escapeHtml(text),
    },
  });
  private readonly purifier: DOMPurify;

  constructor(document: Document) {
    const window = document.defaultView;
    if (window === null) {
      throw new InvariantViolation('Markdown needs a document that belongs to a window');
    }
    this.purifier = createDOMPurify(window);
    this.purifier.addHook('afterSanitizeAttributes', (node) => {
      if (node.nodeName === 'A' && node.hasAttribute('href')) {
        node.setAttribute('target', LINK_TARGET);
        node.setAttribute('rel', LINK_REL);
      }
    });
  }

  render(text: string): DocumentFragment {
    const html = this.markdown.parse(text, { async: false }).trim();
    return this.purifier.sanitize(html, SANITIZE);
  }
}
