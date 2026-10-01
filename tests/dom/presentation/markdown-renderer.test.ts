import { describe, expect, it } from 'vitest';
import { MarkdownRenderer } from '../../../src/presentation/markdown-renderer';
import { InvariantViolation } from '../../../src/domain/errors';

const renderer = new MarkdownRenderer(document);

function render(text: string): HTMLElement {
  const host = document.createElement('div');
  host.append(renderer.render(text));
  return host;
}

describe('Markdown renderer', () => {
  it('renders headings, emphasis, lists and blockquotes', () => {
    const host = render('## Plan\n\n**bold** and *italic*\n\n- one\n- two\n\n3. first\n\n> quoted');
    expect(host.querySelector('h2')?.textContent).toBe('Plan');
    expect(host.querySelector('strong')?.textContent).toBe('bold');
    expect(host.querySelector('em')?.textContent).toBe('italic');
    expect([...host.querySelectorAll('ul > li')].map((item) => item.textContent)).toEqual([
      'one',
      'two',
    ]);
    expect(host.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(host.querySelector('ol > li')?.textContent).toBe('first');
    expect(host.querySelector('blockquote')?.textContent.trim()).toBe('quoted');
  });

  it('keeps single line breaks of the model', () => {
    expect(render('first\nsecond').querySelector('p')?.innerHTML).toBe('first<br>second');
  });

  it('keeps every backslash of LaTeX in inline code and fenced code blocks', () => {
    const latex = '\\begin{table}\n  a & b \\\\\n  \\hline\n\\end{table}';
    const host = render(`Use \`\\\\section{A}\`:\n\n\`\`\`latex\n${latex}\n\`\`\``);
    expect(host.querySelector('p > code')?.textContent).toBe('\\\\section{A}');
    expect(host.querySelector('pre > code')?.textContent).toBe(`${latex}\n`);
  });

  it('renders tables with their alignment', () => {
    const host = render('| Name | Value |\n| :--- | ---: |\n| a | 1 |');
    expect([...host.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual([
      'Name',
      'Value',
    ]);
    expect([...host.querySelectorAll('td')].map((cell) => cell.getAttribute('align'))).toEqual([
      'left',
      'right',
    ]);
  });

  it('opens web and mail links in a new tab without access to the opener', () => {
    const host = render('[docs](https://overleaf.com/learn) and [mail](mailto:a@b.pl)');
    const links = [...host.querySelectorAll('a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://overleaf.com/learn',
      'mailto:a@b.pl',
    ]);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it.each([
    ['javascript:', '[x](javascript:alert(1))'],
    ['javascript: with entities', '[x](jav&#x09;ascript:alert(1))'],
    ['data:', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['vbscript:', '[x](vbscript:msgbox)'],
    ['a relative path', '[x](/project/1/delete)'],
  ])('drops a link to %s', (_, text) => {
    const link = render(text).querySelector('a');
    expect(link?.textContent).toBe('x');
    expect(link?.hasAttribute('href')).toBe(false);
    expect(link?.hasAttribute('target')).toBe(false);
  });

  it.each([
    ['a script', '<script>alert(1)</script>'],
    ['an event handler', '<img src=x onerror="alert(1)">'],
    ['an inline handler in a paragraph', 'text <b onclick="alert(1)">bold</b> text'],
    [
      'nested HTML',
      '<div><p><a href="javascript:alert(1)">x</a><iframe src="https://e.vil"></iframe></p></div>',
    ],
    ['a style', '<span style="position:fixed">x</span>'],
    ['an SVG', '<svg><script>alert(1)</script></svg>'],
  ])('shows raw HTML with %s as text', (_, html) => {
    const host = render(html);
    expect(host.querySelector('script, img, iframe, svg, span, div, b, [onclick], [style]')).toBe(
      null,
    );
    expect(host.textContent).toContain(html);
  });

  it('shows an image as its description without loading it', () => {
    const host = render('![frog](https://e.vil/track.png) ![x](data:image/png;base64,AAAA)');
    expect(host.querySelector('img')).toBe(null);
    expect(host.textContent.trim()).toBe('frog x');
  });

  it('allows no attribute that styles or scripts the page', () => {
    const host = render('<p style="color:red" onclick="x">a</p>\n\n[a](https://a.pl "t")');
    const attributes = [...host.querySelectorAll('*')].flatMap((node) => node.getAttributeNames());
    expect(new Set(attributes)).toEqual(new Set(['href', 'title', 'target', 'rel']));
  });

  it('refuses a document without a window', () => {
    const detached = document.implementation.createHTMLDocument('');
    expect(() => new MarkdownRenderer(detached)).toThrow(InvariantViolation);
  });
});
