/**
 * Minimal .env loader for standalone scripts.
 *
 * Next.js loads .env automatically; `tsx` does not. Importing this module first gives
 * scripts the same configuration the application sees. Existing environment variables
 * always win, so CI and container environments override the file.
 *
 * Deliberately dependency-free — this runs before anything else and should not be able
 * to fail for a reason unrelated to configuration.
 */
import fs from 'node:fs';
import path from 'node:path';

function parse(contents: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const equals = line.indexOf('=');
    if (equals === -1) continue;

    const key = line.slice(0, equals).trim();
    if (!key) continue;

    let value = line.slice(equals + 1).trim();
    // Strip matching surrounding quotes, keeping any inside the value.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

export function loadDotenv(files = ['.env.local', '.env']): void {
  for (const file of files) {
    const fullPath = path.resolve(process.cwd(), file);
    if (!fs.existsSync(fullPath)) continue;

    const parsed = parse(fs.readFileSync(fullPath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

loadDotenv();
