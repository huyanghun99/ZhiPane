// Derive the searchable/LLM-facing plain text from a ProseMirror document.
// The editor's source of truth is `contentJson`; `textContent` is derived.
export type PMNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: PMNode[];
};

// Block-level nodes that should be separated by newlines in the plain text.
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'listItem',
  'taskItem',
  'bulletList',
  'orderedList',
  'taskList',
  'codeBlock',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'horizontalRule',
  'callout',
  'toggle'
]);

export function extractText(node: PMNode | null | undefined): string {
  if (!node) return '';
  const out: string[] = [];
  const walk = (n: PMNode) => {
    if (n.type === 'image' && n.attrs) {
      const alt = String(n.attrs.alt ?? n.attrs.title ?? '');
      if (alt) out.push(alt);
    }
    if (n.type === 'mermaid' && n.attrs) {
      const code = String(n.attrs.code ?? '');
      if (code) out.push(code);
    }
    if ((n.type === 'video' || n.type === 'audio' || n.type === 'pdf' || n.type === 'file') && n.attrs) {
      const name = String(n.attrs.fileName ?? '');
      if (name) out.push(`[附件:${name}]`);
    }
    if ((n.type === 'mathBlock' || n.type === 'mathInline') && n.attrs) {
      const latex = String(n.attrs.latex ?? '');
      if (latex) out.push(latex);
    }
    if (n.type === 'drawio') out.push('[Draw.io 流程图]');
    if (n.type === 'excalidraw') out.push('[Excalidraw 白板]');
    if (n.type === 'toggle' && n.attrs?.summary) {
      out.push(String(n.attrs.summary));
    }
    if (typeof n.text === 'string') {
      // Inline code / links keep their text; marks don't change extraction.
      out.push(n.text);
    }
    if (Array.isArray(n.content)) {
      n.content.forEach((child) => {
        walk(child);
        if (BLOCK_TYPES.has(child.type ?? '')) {
          out.push('\n');
        } else if (child.type === 'tableCell' || child.type === 'tableHeader') {
          out.push('  ');
        }
      });
    }
  };
  walk(node);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function countWords(text: string): number {
  if (!text) return 0;
  // Count CJK characters individually and latin words by whitespace groups.
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const latin = (text.replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9]+/g) ?? []).length;
  return cjk + latin;
}

export const emptyDoc: PMNode = { type: 'doc', content: [{ type: 'paragraph' }] };

// ---- ProseMirror JSON -> HTML (read-only render for share / print) ----

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type Mark = { type: string; attrs?: Record<string, unknown> };

function renderInline(node: PMNode): string {
  if (node.type === 'text') {
    let text = escapeHtml(node.text ?? '');
    const marks = (node.marks ?? []) as Mark[];
    for (const m of marks) {
      const href = m.attrs?.href ? escapeHtml(String(m.attrs.href)) : '';
      const color = m.attrs?.color ? escapeHtml(String(m.attrs.color)) : '';
      if (m.type === 'bold') text = `<strong>${text}</strong>`;
      else if (m.type === 'italic') text = `<em>${text}</em>`;
      else if (m.type === 'code') text = `<code>${text}</code>`;
      else if (m.type === 'strike') text = `<s>${text}</s>`;
      else if (m.type === 'underline') text = `<u>${text}</u>`;
      else if (m.type === 'highlight') text = `<mark>${text}</mark>`;
      else if (m.type === 'link') text = `<a href="${href}" target="_blank" rel="noreferrer">${text}</a>`;
      else if (m.type === 'textStyle' && color) text = `<span style="color:${color}">${text}</span>`;
    }
    return text;
  }
  if (node.type === 'mathInline' && node.attrs) return `\\(${escapeHtml(String(node.attrs.latex ?? ''))}\\)`;
  if (node.type === 'image' && node.attrs)
    return `<img src="${escapeHtml(String(node.attrs.src ?? ''))}" alt="${escapeHtml(String(node.attrs.alt ?? ''))}" />`;
  if (Array.isArray(node.content)) return node.content.map(renderInline).join('');
  return '';
}

function renderContent(node: PMNode): string {
  return (node.content ?? []).map(renderBlock).join('');
}

function renderBlock(node: PMNode): string {
  const a = node.attrs ?? {};
  switch (node.type) {
    case 'paragraph': return `<p>${renderInline(node)}</p>`;
    case 'heading': { const lvl = Math.min(6, Math.max(1, Number(a.level ?? 1))); return `<h${lvl}>${renderInline(node)}</h${lvl}>`; }
    case 'codeBlock':
      return `<pre><code${a.language ? ` class="language-${escapeHtml(String(a.language))}"` : ''}>${escapeHtml((node.content ?? []).map((n) => n.text ?? '').join(''))}</code></pre>`;
    case 'blockquote': return `<blockquote>${renderContent(node)}</blockquote>`;
    case 'bulletList': return `<ul>${renderContent(node)}</ul>`;
    case 'orderedList': return `<ol>${renderContent(node)}</ol>`;
    case 'taskList': return `<ul class="task-list">${renderContent(node)}</ul>`;
    case 'listItem': return `<li>${renderContent(node)}</li>`;
    case 'taskItem': return `<li class="task-item"><input type="checkbox" disabled ${a.checked ? 'checked' : ''}/> ${renderContent(node)}</li>`;
    case 'horizontalRule': return '<hr/>';
    case 'callout': return `<div class="callout callout-${escapeHtml(String(a.type ?? 'info'))}">${renderContent(node)}</div>`;
    case 'toggle': return `<details><summary>${escapeHtml(String(a.summary ?? ''))}</summary>${renderContent(node)}</details>`;
    case 'mathBlock': return `<div class="math-block">\\[${escapeHtml(String(a.latex ?? ''))}\\]</div>`;
    case 'mermaid': return `<pre class="mermaid-block">${escapeHtml(String(a.code ?? ''))}</pre>`;
    case 'drawio': return `<div class="embed-placeholder">[Draw.io 流程图]</div>`;
    case 'excalidraw': return `<div class="embed-placeholder">[Excalidraw 白板]</div>`;
    case 'embed': return `<a href="${escapeHtml(String(a.url ?? ''))}" target="_blank" rel="noreferrer">${escapeHtml(String(a.url ?? ''))}</a>`;
    case 'image': return `<img src="${escapeHtml(String(a.src ?? ''))}" alt="${escapeHtml(String(a.alt ?? ''))}" />`;
    case 'video': return `<video src="${escapeHtml(String(a.src ?? ''))}" controls />`;
    case 'audio': return `<audio src="${escapeHtml(String(a.src ?? ''))}" controls />`;
    case 'pdf': return `<a href="${escapeHtml(String(a.src ?? ''))}" target="_blank" rel="noreferrer">[PDF 文件]</a>`;
    case 'file': return `<a href="${escapeHtml(String(a.src ?? ''))}" target="_blank" rel="noreferrer">${escapeHtml(String(a.fileName ?? '文件'))}</a>`;
    case 'table': return `<table>${renderContent(node)}</table>`;
    case 'tableRow': return `<tr>${renderContent(node)}</tr>`;
    case 'tableHeader': return `<th>${renderContent(node)}</th>`;
    case 'tableCell': return `<td>${renderContent(node)}</td>`;
    default: return renderContent(node);
  }
}

export function docToHtml(node: PMNode | null | undefined): string {
  if (!node) return '';
  if (node.type === 'doc') return renderContent(node);
  return renderBlock(node);
}
