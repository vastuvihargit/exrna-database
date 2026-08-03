/**
 * Validates the environment without starting the app.
 * Useful as a deploy gate: `npm run check:env` fails loudly before containers roll.
 */
import './load-dotenv';

import { loadEnv } from '../src/server/config/env';

try {
  const env = loadEnv();
  console.log('✓ Environment configuration is valid');
  console.log(`  environment      : ${env.NODE_ENV}`);
  console.log(`  database         : ${env.MONGODB_DATABASE}`);
  console.log(`  email domains    : ${env.COMPANY_EMAIL_DOMAINS.join(', ')}`);
  console.log(`  auto-provisioning: ${env.ALLOW_AUTO_PROVISIONING ? 'enabled' : 'disabled'}`);
  console.log(`  max upload       : ${env.MAX_UPLOAD_SIZE_MB} MB`);
  console.log('  storage roots    :');
  for (const [name, root] of Object.entries(env.storageRoots)) {
    console.log(`    ${name.padEnd(10)} ${root}`);
  }
  process.exit(0);
} catch (error) {
  console.error('✗ Environment configuration is invalid\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
