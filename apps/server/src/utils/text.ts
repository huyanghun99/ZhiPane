const asciiWord = /[a-zA-Z0-9_]+/g;

export function tokenizeChineseFriendly(input: string): string {
  const text = input.normalize('NFKC').toLowerCase();
  const tokens: string[] = [];
  for (const match of text.matchAll(asciiWord)) tokens.push(match[0]);
  const chars = [...text].filter((c) => /[\u4e00-\u9fff]/u.test(c));
  for (let i = 0; i < chars.length; i++) {
    tokens.push(chars[i]);
    if (i + 1 < chars.length) tokens.push(chars[i] + chars[i + 1]);
    if (i + 2 < chars.length) tokens.push(chars[i] + chars[i + 1] + chars[i + 2]);
  }
  return [...new Set(tokens)].join(' ');
}

export function extractTextFromProseMirrorJson(content: unknown): string {
  const chunks: string[] = [];
  function visit(node: any) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') chunks.push(node.text);
    if (node.attrs?.text) chunks.push(String(node.attrs.text));
    if (Array.isArray(node.content)) node.content.forEach(visit);
  }
  visit(content);
  return chunks.join('\n').trim();
}

export function chunkText(text: string, maxSize = 800, overlap = 150): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    const part = clean.slice(i, i + maxSize).trim();
    if (part) chunks.push(part);
    i += Math.max(1, maxSize - overlap);
  }
  return chunks;
}


/* ----------------------------------------------- P0-2 structured blocks -----
 * LLM wiki优化.md P0-2: 保留编辑器结构
 *
 * ProseMirror content_json 转换为结构化 DocumentBlock[], 至少保留:
 *   - 标题及层级
 *   - 段落
 *   - 列表层级
 *   - 引用
 *   - 图片说明
 *   - 原文位置 (字符偏移)
 *   - 稳定 Block ID
 *
 * 切分优先按章节和完整段落进行, 禁止从句子中间截断。
 */

export type DocumentBlockType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'listItem'
  | 'blockquote'
  | 'codeBlock'
  | 'table'
  | 'image'
  | 'caption'
  | 'other';

export interface DocumentBlock {
  /** Stable block ID for evidence referencing (e.g. "blk-0001") */
  blockId: string;
  /** Block type derived from ProseMirror node type */
  type: DocumentBlockType;
  /** Heading level (1-6) for headings; list depth for list items; 0 otherwise */
  level: number;
  /** Plain text content of this block (not including children) */
  text: string;
  /** Nested blocks (list items, table cells, blockquote contents) */
  children?: DocumentBlock[];
  /** Character offset of this block's text in the full document text */
  position: number;
}

export interface DocumentSegment {
  /** Stable segment ID (e.g. "seg-0001") */
  segmentId: string;
  /** Block IDs included in this segment */
  blockIds: string[];
  /** Concatenated text of all blocks in this segment */
  text: string;
  /** Heading breadcrumb for context, e.g. ["第一章", "1.2 背景"] */
  headingPath: string[];
}

const PM_HEADING_LEVELS = new Set([1, 2, 3, 4, 5, 6]);

function pmBlockType(nodeType: string): DocumentBlockType {
  switch (nodeType) {
    case 'heading': return 'heading';
    case 'paragraph': return 'paragraph';
    case 'bulletList':
    case 'orderedList': return 'list';
    case 'listItem': return 'listItem';
    case 'blockquote': return 'blockquote';
    case 'codeBlock': return 'codeBlock';
    case 'table': return 'table';
    case 'image': return 'image';
    default: return 'other';
  }
}

/** Extract inline text from a ProseMirror node (handles text + hardBreak). */
function pmNodeText(node: any): string {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'hardBreak') return '\n';
  if (node.attrs?.text) return String(node.attrs.text);
  if (node.attrs?.alt) return String(node.attrs.alt);
  if (Array.isArray(node.content)) return node.content.map(pmNodeText).join('');
  return '';
}

/**
 * Convert ProseMirror content_json into structured DocumentBlock[].
 * Preserves heading levels, list nesting, blockquotes, images, and positions.
 */
export function proseMirrorToDocumentBlocks(content: unknown): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  let blockCounter = 0;
  let charOffset = 0;

  function visit(node: any, depth: number): void {
    if (!node || typeof node !== 'object') return;
    const isDoc = node.type === 'doc';
    const isContentArray = Array.isArray(node);

    if (isContentArray) {
      node.forEach((child: any) => visit(child, depth));
      return;
    }

    if (!isDoc) {
      const type = pmBlockType(node.type || '');
      const level =
        type === 'heading'
          ? (typeof node.attrs?.level === 'number' && PM_HEADING_LEVELS.has(node.attrs.level) ? node.attrs.level : 1)
          : type === 'listItem'
            ? depth
            : 0;
      const text = pmNodeText(node).trim();
      const blockId = `blk-${String(++blockCounter).padStart(4, '0')}`;
      const block: DocumentBlock = {
        blockId,
        type,
        level,
        text,
        position: charOffset
      };
      charOffset += text.length + 1; // +1 for the \n separator

      // Recurse into children (list items, blockquote contents, table cells).
      if (Array.isArray(node.content) && node.content.length > 0) {
        const children: DocumentBlock[] = [];
        let childCounter = 0;
        let childOffset = 0;
        function visitChildren(childNode: any, childDepth: number): void {
          if (!childNode || typeof childNode !== 'object') return;
          if (Array.isArray(childNode)) {
            childNode.forEach((c: any) => visitChildren(c, childDepth));
            return;
          }
          const childType = pmBlockType(childNode.type || '');
          const childLevel =
            childType === 'heading'
              ? (typeof childNode.attrs?.level === 'number' && PM_HEADING_LEVELS.has(childNode.attrs.level) ? childNode.attrs.level : 1)
              : childType === 'listItem'
                ? childDepth
                : 0;
          const childText = pmNodeText(childNode).trim();
          if (childText || childType !== 'other') {
            children.push({
              blockId: `${blockId}.${String(++childCounter).padStart(2, '0')}`,
              type: childType,
              level: childLevel,
              text: childText,
              position: charOffset + childOffset
            });
            childOffset += childText.length + 1;
          }
          if (Array.isArray(childNode.content)) visitChildren(childNode.content, childDepth + 1);
        }
        if (type === 'list' || type === 'blockquote' || type === 'table') {
          visitChildren(node.content, depth + 1);
          if (children.length > 0) block.children = children;
        }
      }

      blocks.push(block);
    }

    // Visit top-level content children (doc content).
    if (isDoc && Array.isArray(node.content)) {
      node.content.forEach((child: any) => visit(child, depth));
    }
  }

  visit(content, 0);
  return blocks;
}

/** Flatten DocumentBlock[] into plain text (depth-first, with \n separators). */
export function documentBlocksToText(blocks: DocumentBlock[]): string {
  const parts: string[] = [];
  function walk(block: DocumentBlock): void {
    if (block.text) parts.push(block.text);
    if (block.children) block.children.forEach(walk);
  }
  blocks.forEach(walk);
  return parts.join('\n').trim();
}

/** Sentence boundary regex: CJK 。！？； and ASCII .!?; followed by space/end. */
const SENTENCE_BOUNDARY = /([。！？；.!?;])(?=\s|$|\n)/;

/**
 * Split a too-long paragraph at sentence boundaries. Never cuts mid-sentence
 * unless a single sentence exceeds maxSize (then it falls back to a hard cut
 * at maxSize, which is still better than the old character-window approach).
 */
function splitLongParagraph(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];
  const sentences: string[] = [];
  let remaining = text;
  while (remaining.length > maxSize) {
    // Find the last sentence boundary within maxSize chars.
    const window = remaining.slice(0, maxSize);
    const boundaryMatch = [...window.matchAll(SENTENCE_BOUNDARY)].pop();
    if (boundaryMatch && boundaryMatch.index !== undefined) {
      const cut = boundaryMatch.index + boundaryMatch[1].length;
      sentences.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut);
    } else {
      // No sentence boundary in window — hard cut at maxSize (last resort).
      sentences.push(remaining.slice(0, maxSize).trim());
      remaining = remaining.slice(maxSize);
    }
  }
  if (remaining.trim()) sentences.push(remaining.trim());
  return sentences;
}

/**
 * Segment DocumentBlock[] into retrieval chunks.
 *
 * Rules (P0-2):
 *   1. A heading starts a new segment (section boundary).
 *   2. Blocks accumulate until maxSize is reached, then close at the next
 *      paragraph boundary (never mid-paragraph).
 *   3. A single paragraph exceeding maxSize is split at sentence boundaries.
 *   4. Each segment records its heading breadcrumb for context.
 */
export function segmentDocumentBlocks(
  blocks: DocumentBlock[],
  maxSize: number = 800
): DocumentSegment[] {
  const segments: DocumentSegment[] = [];
  let segCounter = 0;
  let currentText = '';
  let currentBlockIds: string[] = [];
  let headingPath: string[] = [];

  function flush(): void {
    if (currentText.trim()) {
      segments.push({
        segmentId: `seg-${String(++segCounter).padStart(4, '0')}`,
        blockIds: currentBlockIds,
        text: currentText.trim(),
        headingPath: [...headingPath]
      });
    }
    currentText = '';
    currentBlockIds = [];
  }

  function appendBlock(block: DocumentBlock, text: string): void {
    const piece = text.trim();
    if (!piece) return;
    // If appending would exceed maxSize AND we already have content,
    // flush first (paragraph boundary).
    if (currentText && currentText.length + piece.length + 1 > maxSize) {
      flush();
    }
    currentBlockIds.push(block.blockId);
    currentText = currentText ? `${currentText}\n${piece}` : piece;
  }

  for (const block of blocks) {
    if (block.type === 'heading' && block.level > 0) {
      // Section boundary: flush current segment, update heading path.
      flush();
      // Keep only headings up to the current level (drop deeper levels).
      headingPath = headingPath.slice(0, block.level - 1);
      headingPath.push(block.text || `第${block.level}级标题`);
      // Headings themselves are small; include them in the new segment.
      appendBlock(block, block.text);
      continue;
    }

    if (block.type === 'image') {
      // Images contribute a caption placeholder, not raw attrs.
      const caption = block.text ? `[图片: ${block.text}]` : '[图片]';
      appendBlock(block, caption);
      continue;
    }

    if (block.type === 'codeBlock') {
      // Code blocks are kept as-is (no sentence splitting).
      const code = block.text || '';
      if (code.length > maxSize) {
        // Long code: flush current, then hard-split by lines.
        flush();
        const lines = code.split('\n');
        let buf = '';
        for (const line of lines) {
          if (buf.length + line.length + 1 > maxSize && buf) {
            appendBlock(block, `\`\`\`\n${buf}\n\`\`\``);
            flush();
            buf = '';
          }
          buf = buf ? `${buf}\n${line}` : line;
        }
        if (buf) appendBlock(block, `\`\`\`\n${buf}\n\`\`\``);
      } else {
        appendBlock(block, `\`\`\`\n${code}\n\`\`\``);
      }
      continue;
    }

    // Paragraph / list item / blockquote / other: split if too long.
    const text = block.text || '';
    if (text.length > maxSize) {
      const parts = splitLongParagraph(text, maxSize);
      for (const part of parts) {
        appendBlock(block, part);
        if (currentText.length >= maxSize) flush();
      }
    } else {
      appendBlock(block, text);
    }

    // Also walk children (list items, table cells) for completeness.
    if (block.children) {
      for (const child of block.children) {
        const childText = child.text || '';
        if (childText.length > maxSize) {
          for (const part of splitLongParagraph(childText, maxSize)) {
            appendBlock(child, part);
            if (currentText.length >= maxSize) flush();
          }
        } else if (childText) {
          appendBlock(child, childText);
        }
      }
    }
  }
  flush();
  return segments;
}

/**
 * Convenience: ProseMirror content_json -> structured segments in one call.
 * Falls back to flat chunkText when content_json is missing/invalid, so the
 * caller (job-runner) stays robust against pages imported before P0-2.
 */
export function segmentProseMirrorContent(
  contentJson: unknown,
  fallbackText: string,
  maxSize: number = 800
): DocumentSegment[] {
  try {
    const blocks = proseMirrorToDocumentBlocks(contentJson);
    if (blocks.length === 0) {
      // No structured content — fall back to flat text chunking.
      return chunkText(fallbackText, maxSize, 0).map((text, i) => ({
        segmentId: `seg-${String(i + 1).padStart(4, '0')}`,
        blockIds: [],
        text,
        headingPath: []
      }));
    }
    return segmentDocumentBlocks(blocks, maxSize);
  } catch {
    // Malformed content_json — fall back to flat text chunking.
    return chunkText(fallbackText, maxSize, 0).map((text, i) => ({
      segmentId: `seg-${String(i + 1).padStart(4, '0')}`,
      blockIds: [],
      text,
      headingPath: []
    }));
  }
}
