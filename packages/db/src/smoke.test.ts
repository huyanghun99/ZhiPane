import { describe, expect, it } from 'vitest';
import {
  users, workspaces, spaces, pages, documentChunks, jobs,
  ragSessions, wikiTopics, llmSuggestions, attachments, shares, backups
} from './schema';

describe('@zhipane/db schema smoke', () => {
  it('exports core table definitions', () => {
    expect(users).toBeDefined();
    expect(workspaces).toBeDefined();
    expect(spaces).toBeDefined();
    expect(pages).toBeDefined();
    expect(documentChunks).toBeDefined();
    expect(jobs).toBeDefined();
  });

  it('exports M2B attachment table', () => {
    expect(attachments).toBeDefined();
  });

  it('exports M4 rag sessions table', () => {
    expect(ragSessions).toBeDefined();
  });

  it('exports M5 wiki topic and suggestion tables', () => {
    expect(wikiTopics).toBeDefined();
    expect(llmSuggestions).toBeDefined();
  });

  it('exports M7 shares table', () => {
    expect(shares).toBeDefined();
  });

  it('exports M8 backups table', () => {
    expect(backups).toBeDefined();
  });
});
