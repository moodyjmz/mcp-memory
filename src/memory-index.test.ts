import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'fs';
import { createTestIndex } from './test-helpers.js';
import type { MemoryIndex } from './memory-index.js';

describe('memory-index', () => {
  let index: MemoryIndex;
  let dir: string;

  beforeEach(() => {
    ({ index, dir } = createTestIndex());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores a fact and returns added: true', async () => {
    const result = await index.addFact('Grunt builds use LESS variables', {
      category: 'architecture',
      file_path: '/build/Gruntfile.js',
    });
    expect(result.added).toBe(true);
    expect(result.id).toBeDefined();
  });

  it('deduplicates identical text', async () => {
    const first = await index.addFact('Theme overrides go in overrides.less', {
      category: 'convention',
    });
    expect(first.added).toBe(true);

    const second = await index.addFact('Theme overrides go in overrides.less', {
      category: 'convention',
    });
    expect(second.added).toBe(false);
    expect(second.existing).toBe('Theme overrides go in overrides.less');
  });

  it('allows sufficiently different facts', async () => {
    const first = await index.addFact('alpha bravo charlie delta echo foxtrot golf hotel', {
      category: 'architecture',
    });
    const second = await index.addFact('zulu yankee xray whiskey victor uniform tango sierra', {
      category: 'architecture',
    });
    expect(first.added).toBe(true);
    expect(second.added).toBe(true);
  });

  it('queries stored facts and returns results', async () => {
    await index.addFact('The build system uses Grunt with LESS preprocessing', {
      category: 'architecture',
    });

    const results = await index.queryFacts('The build system uses Grunt with LESS preprocessing');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain('Grunt');
  });

  it('queries with topK limit', async () => {
    // Use very distinct texts to avoid dedup
    const texts = [
      'alpha bravo charlie delta echo',
      'foxtrot golf hotel india juliet',
      'kilo lima mike november oscar',
      'papa quebec romeo sierra tango',
      'uniform victor whiskey xray zulu',
    ];
    for (const text of texts) {
      await index.addFact(text, { category: 'gotcha' });
    }

    const results = await index.queryFacts('alpha bravo charlie', 2);
    expect(results.length).toBeLessThanOrEqual(2);
    expect(results.length).toBeGreaterThan(0);
  });

  it('deletes a fact', async () => {
    const { id } = await index.addFact('Temporary fact to delete', {
      category: 'gotcha',
    });

    await index.deleteFact(id);

    const results = await index.queryFacts('Temporary fact to delete', 5);
    const found = results.find(r => r.id === id);
    expect(found).toBeUndefined();
  });

  it('updateFact replaces vector and text is queryable under new content', async () => {
    const { id } = await index.addFact('alpha bravo charlie', { category: 'gotcha' });

    await index.updateFact(id, 'completely different updated content about databases', {
      category: 'architecture',
    });

    // New content should be findable
    const results = await index.queryFacts('completely different updated content about databases', 5);
    const found = results.find(r => r.id === id);
    expect(found).toBeDefined();
    expect(found!.text).toBe('completely different updated content about databases');
  });

  it('updateFact on missing id inserts fresh', async () => {
    // Should not throw even if id doesn't exist in index
    await expect(
      index.updateFact('nonexistent-id', 'some text', { category: 'gotcha' })
    ).resolves.not.toThrow();
  });

  it('filters by project', async () => {
    await index.addFact('web-apps uses LESS for styling and theming', {
      category: 'architecture',
      project: 'web-apps',
    });
    await index.addFact('memory server uses SQLite for persistence', {
      category: 'architecture',
      project: 'claude-memory',
    });

    const results = await index.queryFacts('styling and theming', 5, 'web-apps');
    expect(results.length).toBeGreaterThan(0);
  });
});
