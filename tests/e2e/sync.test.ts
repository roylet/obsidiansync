import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isConflictPath } from '@obsidiansync/protocol';
import { Device, E2EHarness } from './harness.js';

/**
 * Convergence tests: two devices, one real server, the real sync engine.
 *
 * These are the tests that stand in for owning a phone, a tablet and two
 * laptops. Each one is a scenario a user will actually hit.
 */

let h: E2EHarness;
let laptop: Device;
let phone: Device;

beforeEach(async () => {
  h = await E2EHarness.create();
  laptop = h.device({ name: 'Laptop' });
  phone = h.device({ name: 'iPhone' });
});

afterEach(async () => {
  await h.dispose();
});

describe('basic propagation', () => {
  it('carries a new note from one device to the other', async () => {
    laptop.edit('notes/hello.md', '# Hello');
    await laptop.sync();
    await phone.sync();

    expect(phone.read('notes/hello.md')).toBe('# Hello');
    expect(h.serverPaths()).toEqual(['notes/hello.md']);
  });

  it('carries an edit made on the second device back to the first', async () => {
    laptop.edit('note.md', 'v1');
    await laptop.sync();
    await phone.sync();

    phone.edit('note.md', 'v2');
    await phone.sync();
    await laptop.sync();

    expect(laptop.read('note.md')).toBe('v2');
  });

  it('settles after repeated round trips without re-uploading anything', async () => {
    laptop.edit('note.md', 'stable');
    await laptop.sync();
    await phone.sync();

    // A quiet cycle on either device should move nothing at all: this is what
    // stops the two of them ping-ponging a file forever.
    for (let i = 0; i < 3; i++) {
      const a = await laptop.sync();
      const b = await phone.sync();
      expect(a.pushed + a.pulled + a.conflicts).toBe(0);
      expect(b.pushed + b.pulled + b.conflicts).toBe(0);
    }
  });

  it('does not treat a file it just pulled as a local change to push back', async () => {
    laptop.edit('note.md', 'content');
    await laptop.sync();

    const pulled = await phone.sync();
    expect(pulled.pulled).toBe(1);

    // Obsidian raises a change event for the file the engine itself wrote.
    phone.engine.markDirty('note.md');
    const after = await phone.sync();
    expect(after.pushed).toBe(0);
  });

  it('creates nested folders on the receiving device', async () => {
    laptop.edit('a/b/c/deep.md', 'nested');
    await laptop.sync();
    await phone.sync();
    expect(phone.read('a/b/c/deep.md')).toBe('nested');
  });

  it('round-trips a note containing non-ASCII text', async () => {
    laptop.edit('note.md', '# Café ☕\nRésumé — naïve');
    await laptop.sync();
    await phone.sync();
    expect(phone.read('note.md')).toBe('# Café ☕\nRésumé — naïve');
  });
});

describe('deletes', () => {
  it('propagates a delete to the other device', async () => {
    laptop.edit('note.md', 'content');
    await laptop.sync();
    await phone.sync();
    expect(phone.vault.has('note.md')).toBe(true);

    laptop.delete('note.md');
    await laptop.sync();
    await phone.sync();

    expect(phone.vault.has('note.md')).toBe(false);
    expect(h.serverPaths()).toEqual([]);
  });

  it('moves a remotely deleted file to the local trash rather than erasing it', async () => {
    laptop.edit('note.md', 'content');
    await laptop.sync();
    await phone.sync();

    laptop.delete('note.md');
    await laptop.sync();
    await phone.sync();

    expect(phone.vault.trashed).toContain('note.md');
  });

  it('keeps a file that was edited here while it was deleted elsewhere', async () => {
    laptop.edit('note.md', 'original');
    await laptop.sync();
    await phone.sync();

    // Both act while unaware of each other.
    laptop.delete('note.md');
    phone.edit('note.md', 'still working on this');

    await laptop.sync();
    await phone.sync();
    await laptop.sync();

    // The edit wins: deleting must never silently destroy someone's work.
    expect(phone.read('note.md')).toBe('still working on this');
    expect(laptop.read('note.md')).toBe('still working on this');
  });
});

describe('conflicts', () => {
  it('keeps both versions when two devices edit the same note offline', async () => {
    laptop.edit('note.md', 'shared starting point');
    await laptop.sync();
    await phone.sync();

    // Neither syncs in between, so neither knows about the other's edit.
    laptop.edit('note.md', 'the laptop version');
    phone.vault.tick(5000); // the phone's edit is the newer one
    phone.edit('note.md', 'the phone version');

    await laptop.sync();
    const phoneOutcome = await phone.sync();

    expect(phoneOutcome.conflicts).toBe(1);

    // Both bodies survive, one at the real path and one beside it.
    const conflictCopy = phone.vault.paths().find(isConflictPath);
    expect(conflictCopy).toBeDefined();

    const bodies = phone.vault.paths().map((p) => phone.read(p));
    expect(bodies).toContain('the phone version');
    expect(bodies).toContain('the laptop version');
  });

  it('gives the newer edit the real path', async () => {
    laptop.edit('note.md', 'base');
    await laptop.sync();
    await phone.sync();

    laptop.edit('note.md', 'older edit');
    phone.vault.tick(60_000);
    phone.edit('note.md', 'newer edit');

    await laptop.sync();
    await phone.sync();

    expect(phone.read('note.md')).toBe('newer edit');
    const copy = phone.vault.paths().find(isConflictPath)!;
    expect(phone.read(copy)).toBe('older edit');
  });

  it('sends the conflict copy to every device, not just the one that made it', async () => {
    laptop.edit('note.md', 'base');
    await laptop.sync();
    await phone.sync();

    laptop.edit('note.md', 'laptop edit');
    phone.vault.tick(5000);
    phone.edit('note.md', 'phone edit');

    await laptop.sync();
    await phone.sync();
    await laptop.sync();

    const copy = phone.vault.paths().find(isConflictPath)!;
    expect(laptop.vault.has(copy)).toBe(true);
    expect(laptop.read(copy)).toBe(phone.read(copy));
  });

  it('names the conflict copy after the device that resolved it', async () => {
    laptop.edit('note.md', 'base');
    await laptop.sync();
    await phone.sync();

    laptop.edit('note.md', 'laptop edit');
    phone.vault.tick(5000);
    phone.edit('note.md', 'phone edit');
    await laptop.sync();
    await phone.sync();

    const copy = phone.vault.paths().find(isConflictPath)!;
    expect(copy).toContain('iPhone');
    expect(copy.endsWith('.md')).toBe(true);
  });

  it('converges: after a conflict both devices hold identical content', async () => {
    laptop.edit('note.md', 'base');
    await laptop.sync();
    await phone.sync();

    laptop.edit('note.md', 'laptop');
    phone.vault.tick(5000);
    phone.edit('note.md', 'phone');

    await laptop.sync();
    await phone.sync();
    await laptop.sync();
    await phone.sync();

    expect(laptop.vault.paths()).toEqual(phone.vault.paths());
    for (const path of laptop.vault.paths()) {
      expect(laptop.read(path), path).toBe(phone.read(path));
    }
  });

  it('does not manufacture a conflict when only one side changed', async () => {
    laptop.edit('note.md', 'base');
    await laptop.sync();
    await phone.sync();

    laptop.edit('note.md', 'only the laptop changed');
    await laptop.sync();
    const outcome = await phone.sync();

    expect(outcome.conflicts).toBe(0);
    expect(phone.read('note.md')).toBe('only the laptop changed');
    expect(phone.vault.paths().some(isConflictPath)).toBe(false);
  });
});

describe('renames', () => {
  it('propagates a rename without re-uploading the body', async () => {
    laptop.edit('old-name.md', 'content');
    await laptop.sync();
    await phone.sync();

    laptop.vault.tick();
    laptop.vault.writeText('new-name.md', 'content');
    await laptop.vault.remove('old-name.md');
    await laptop.engine.handleRename('old-name.md', 'new-name.md');

    await phone.sync();

    expect(phone.read('new-name.md')).toBe('content');
    expect(phone.vault.has('old-name.md')).toBe(false);
    expect(h.serverPaths()).toEqual(['new-name.md']);
  });
});

describe('a device that has been offline', () => {
  it('catches up on many changes at once', async () => {
    await phone.sync(); // pair the phone, then leave it alone

    for (let i = 0; i < 25; i++) {
      laptop.edit(`notes/note-${i}.md`, `body ${i}`);
    }
    await laptop.sync();
    await phone.sync();

    expect(phone.vault.paths()).toHaveLength(25);
    expect(phone.read('notes/note-7.md')).toBe('body 7');
  });

  it('recovers when its cursor is too old to use', async () => {
    laptop.edit('a.md', 'one');
    await laptop.sync();
    await phone.sync();

    // The laptop deletes something and the tombstone is later purged, which is
    // exactly what the retention sweep does after TRASH_RETENTION_DAYS.
    laptop.edit('b.md', 'two');
    await laptop.sync();
    laptop.delete('b.md');
    await laptop.sync();
    laptop.edit('c.md', 'three');
    await laptop.sync();
    h.db.purgeTombstones(Date.now() + 1000);
    laptop.edit('d.md', 'four');
    await laptop.sync();
    laptop.delete('c.md');
    await laptop.sync();

    // The phone's cursor now predates the purge; it must renegotiate rather
    // than silently miss the delete.
    await phone.sync();

    expect(phone.vault.has('b.md')).toBe(false);
    expect(phone.vault.has('c.md')).toBe(false);
    expect(phone.read('d.md')).toBe('four');
    expect(phone.vault.paths().sort()).toEqual(h.serverPaths());
  });

  it('joins an existing vault from scratch and pulls everything', async () => {
    laptop.edit('a.md', 'one');
    laptop.edit('b/c.md', 'two');
    await laptop.sync();

    const newDevice = h.device({ name: 'Tablet' });
    await newDevice.sync();

    expect(newDevice.vault.paths()).toEqual(['a.md', 'b/c.md']);
  });

  it('merges a device that already had its own notes before pairing', async () => {
    laptop.edit('from-laptop.md', 'laptop content');
    await laptop.sync();

    const tablet = h.device({ name: 'Tablet', seed: { 'from-tablet.md': 'tablet content' } });
    await tablet.sync();
    await laptop.sync();

    expect(tablet.read('from-laptop.md')).toBe('laptop content');
    expect(laptop.read('from-tablet.md')).toBe('tablet content');
    expect(h.serverPaths()).toEqual(['from-laptop.md', 'from-tablet.md']);
  });
});

describe('scope', () => {
  it('never uploads ignored files', async () => {
    laptop.edit('notes/keep.md', 'keep');
    laptop.edit('.obsidian/workspace.json', '{"panes":[]}');
    laptop.edit('.git/config', '[core]');
    laptop.edit('notes/.DS_Store', 'junk');
    await laptop.sync(true);

    expect(h.serverPaths()).toEqual(['notes/keep.md']);
  });

  it('syncs the config folder when the option is on, minus per-device layout', async () => {
    const a = h.device({ name: 'A', syncConfig: true });
    const b = h.device({ name: 'B', syncConfig: true });

    a.edit('.obsidian/appearance.json', '{"theme":"obsidian"}');
    a.edit('.obsidian/workspace.json', '{"panes":["left"]}');
    await a.sync(true);
    await b.sync(true);

    expect(b.read('.obsidian/appearance.json')).toBe('{"theme":"obsidian"}');
    // Window layout is per-device and must never travel.
    expect(b.vault.has('.obsidian/workspace.json')).toBe(false);
  });

  it('honours user ignore patterns', async () => {
    const a = h.device({ name: 'A', patterns: ['private/'] });
    a.edit('private/diary.md', 'secret');
    a.edit('public/note.md', 'shared');
    await a.sync(true);

    expect(h.serverPaths()).toEqual(['public/note.md']);
  });
});

describe('three devices', () => {
  it('converge on the same vault contents', async () => {
    const tablet = h.device({ name: 'Tablet' });

    laptop.edit('a.md', 'from laptop');
    await laptop.sync();

    phone.edit('b.md', 'from phone');
    await phone.sync();

    tablet.edit('c.md', 'from tablet');
    await tablet.sync();

    // Two rounds: one to publish, one to collect what the others published.
    for (const device of [laptop, phone, tablet]) await device.sync();
    for (const device of [laptop, phone, tablet]) await device.sync();

    const expected = ['a.md', 'b.md', 'c.md'];
    expect(laptop.vault.paths()).toEqual(expected);
    expect(phone.vault.paths()).toEqual(expected);
    expect(tablet.vault.paths()).toEqual(expected);
    expect(h.serverPaths()).toEqual(expected);
  });
});
