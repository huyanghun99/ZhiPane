import { describe, it, expect } from 'vitest';
import { classifyUrl, isSingleUrl } from './url';

describe('classifyUrl', () => {
  it('detects image extensions', () => {
    expect(classifyUrl('https://x.com/a.png')).toBe('image');
    expect(classifyUrl('https://x.com/a.JPEG?token=1')).toBe('image');
  });

  it('detects video / audio extensions', () => {
    expect(classifyUrl('https://x.com/a.mp4')).toBe('video');
    expect(classifyUrl('https://x.com/a.mp3')).toBe('audio');
  });

  it('detects embeddable hosts', () => {
    expect(classifyUrl('https://www.youtube.com/watch?v=1')).toBe('embed');
    expect(classifyUrl('https://www.figma.com/file/abc')).toBe('embed');
    expect(classifyUrl('https://bilibili.com/video/1')).toBe('embed');
  });

  it('falls back to link for plain urls', () => {
    expect(classifyUrl('https://example.com/page')).toBe('link');
    expect(classifyUrl('not a url')).toBe('link');
    expect(classifyUrl('https://a.com/a.txt')).toBe('link');
  });
});

describe('isSingleUrl', () => {
  it('true for one url line', () => {
    expect(isSingleUrl('https://x.com/a.png')).toBe(true);
  });
  it('false for multi-line text', () => {
    expect(isSingleUrl('line one\nhttps://x.com')).toBe(false);
  });
  it('false for plain text', () => {
    expect(isSingleUrl('hello world')).toBe(false);
  });
});
