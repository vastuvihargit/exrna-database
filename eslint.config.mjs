import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['.next/**', 'node_modules/**', 'coverage/**', '.data/**'],
  },
  {
    // ── Architectural boundary #1 ────────────────────────────────────────────
    // UI code must never reach the database, the filesystem, or the storage layer.
    // Everything server-side goes through /api route handlers.
    files: ['src/app/**/*.tsx', 'src/components/**/*.tsx', 'src/hooks/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/server/db/*',
                '@/server/repositories/*',
                '@/server/storage/*',
                '@/server/services/*',
                'mongoose',
                'fs',
                'node:fs',
                'fs/promises',
                'node:fs/promises',
              ],
              message:
                'UI components must not access the database, filesystem or storage layer directly. Call an /api route handler instead (see docs/phase-0/02-architecture.md).',
            },
          ],
        },
      ],
    },
  },
  {
    // ── Architectural boundary #2 ────────────────────────────────────────────
    // The server core stays framework-free so it can be lifted into NestJS later.
    files: ['src/server/**/*.ts'],
    ignores: ['src/server/http/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next/*', 'next', 'react', 'react-dom'],
              message:
                'src/server/** must stay framework-agnostic so the backend can be extracted into NestJS. Keep Next.js types in src/server/http/** or the route handler.',
            },
          ],
        },
      ],
    },
  },
  {
    // ── Architectural boundary #3 ────────────────────────────────────────────
    // Only the storage layer touches the filesystem.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/server/storage/**', 'src/server/config/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'fs',
              message: 'Use the StorageProvider abstraction (src/server/storage) instead of fs.',
            },
            {
              name: 'node:fs',
              message: 'Use the StorageProvider abstraction (src/server/storage) instead of fs.',
            },
            {
              name: 'fs/promises',
              message: 'Use the StorageProvider abstraction (src/server/storage) instead of fs.',
            },
            {
              name: 'node:fs/promises',
              message: 'Use the StorageProvider abstraction (src/server/storage) instead of fs.',
            },
          ],
        },
      ],
    },
  },
];

export default config;
