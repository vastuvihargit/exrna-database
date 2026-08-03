'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * Multi-select for a list of drive items.
 *
 * Keys are `"folder:<id>"` / `"file:<id>"` so folders and files can share one set without
 * an id collision ever selecting the wrong thing.
 *
 * The set is never pruned when the underlying list changes. Everything derived from it is
 * intersected with the list that is on screen right now, so a stale entry — a file that
 * was moved away, a row on a page you have left — simply stops counting. Pruning in an
 * effect would mean writing state during render of the very list that feeds it, which is
 * how selection hooks end up looping.
 */
export interface Selection {
  /** Only the keys that are both selected and currently visible, in list order. */
  keys: string[];
  count: number;
  has: (key: string) => boolean;
  /** Plain click replaces the selection; ⌘/Ctrl adds; Shift extends from the last click. */
  toggle: (key: string, modifiers?: { shift?: boolean; meta?: boolean }) => void;
  /** Adds or removes one key without disturbing the rest — what a checkbox does. */
  set: (key: string, selected: boolean) => void;
  selectAll: () => void;
  clear: () => void;
  allSelected: boolean;
  someSelected: boolean;
}

export function itemKey(kind: 'folder' | 'file', id: string): string {
  return `${kind}:${id}`;
}

export function useSelection(orderedKeys: string[]): Selection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);

  const keys = useMemo(
    () => orderedKeys.filter((key) => selected.has(key)),
    [orderedKeys, selected],
  );

  const has = useCallback((key: string) => selected.has(key), [selected]);

  const set = useCallback((key: string, isSelected: boolean) => {
    anchor.current = key;
    setSelected((current) => {
      const next = new Set(current);
      if (isSelected) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const toggle = useCallback(
    (key: string, modifiers?: { shift?: boolean; meta?: boolean }) => {
      if (modifiers?.shift && anchor.current) {
        const from = orderedKeys.indexOf(anchor.current);
        const to = orderedKeys.indexOf(key);
        if (from !== -1 && to !== -1) {
          const [start, end] = from <= to ? [from, to] : [to, from];
          const range = orderedKeys.slice(start, end + 1);
          setSelected((current) => new Set([...current, ...range]));
          return;
        }
      }

      anchor.current = key;

      if (modifiers?.meta) {
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        return;
      }

      // A plain click means "just this one" — the behaviour every file manager has, and
      // the only way to get back to a single item without hunting for a Clear button.
      setSelected((current) => (current.size === 1 && current.has(key) ? new Set() : new Set([key])));
    },
    [orderedKeys],
  );

  const selectAll = useCallback(() => setSelected(new Set(orderedKeys)), [orderedKeys]);

  const clear = useCallback(() => {
    anchor.current = null;
    setSelected(new Set());
  }, []);

  return {
    keys,
    count: keys.length,
    has,
    toggle,
    set,
    selectAll,
    clear,
    allSelected: orderedKeys.length > 0 && keys.length === orderedKeys.length,
    someSelected: keys.length > 0 && keys.length < orderedKeys.length,
  };
}
