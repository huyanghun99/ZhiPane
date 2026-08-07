export interface IndexabilityRule {
  contentType: string;
  fullText: boolean;
  vector: boolean;
  llmWiki: boolean;
  export: boolean;
  print: boolean;
  notes: string;
}

export const contentIndexabilityMatrix: IndexabilityRule[] = [
  { contentType: 'plain_text', fullText: true, vector: true, llmWiki: true, export: true, print: true, notes: 'Primary LLM input' },
  { contentType: 'mermaid_source', fullText: true, vector: true, llmWiki: true, export: true, print: true, notes: 'Render as diagram for print' },
  { contentType: 'katex_source', fullText: true, vector: true, llmWiki: true, export: true, print: true, notes: 'Render as formula for print' },
  { contentType: 'drawio', fullText: true, vector: false, llmWiki: false, export: true, print: true, notes: 'Only metadata is indexed in MVP' },
  { contentType: 'excalidraw', fullText: true, vector: false, llmWiki: false, export: true, print: true, notes: 'Only metadata is indexed in MVP' },
  { contentType: 'pdf_attachment', fullText: true, vector: false, llmWiki: false, export: true, print: true, notes: 'Content extraction is v2' },
  { contentType: 'iframe_embed', fullText: true, vector: false, llmWiki: false, export: true, print: true, notes: 'Only URL/provider/title are indexed' }
];
