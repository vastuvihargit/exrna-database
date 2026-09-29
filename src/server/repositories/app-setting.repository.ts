/**
 * Runtime settings — a façade over the MongoDB and D1 implementations.
 *
 * Routed by `DATA_SOURCE_APP_SETTINGS`.
 *
 * Moving this flag does not carry the settings across: values written before the flip live in
 * the other database, and a key that is absent reads as unset — which for most consumers means
 * falling back to the environment default. That is a quiet behaviour change rather than an
 * error, which is exactly why the migration must copy this table and the runbook must not treat
 * this flag as independently movable.
 */
import { isD1 } from './data-source';
import { mongoAppSettingRepository } from './app-setting.repository.mongo';
import { d1AppSettingRepository } from './app-setting.repository.d1';
import type {
  AppSettingRecord,
  AppSettingRepository,
  PutAppSettingInput,
} from './app-setting.repository.contract';

export type { AppSettingRecord, AppSettingRepository, PutAppSettingInput };
export { mongoAppSettingRepository, d1AppSettingRepository };

function active(): AppSettingRepository {
  return isD1('appSettings') ? d1AppSettingRepository : mongoAppSettingRepository;
}

export function get(organizationId: string, key: string): Promise<AppSettingRecord | null> {
  return active().get(organizationId, key);
}

export function getMany(
  organizationId: string,
  keys: string[],
): Promise<Map<string, AppSettingRecord>> {
  return active().getMany(organizationId, keys);
}

export function put(input: PutAppSettingInput): Promise<AppSettingRecord> {
  return active().put(input);
}

export function remove(organizationId: string, key: string): Promise<boolean> {
  return active().remove(organizationId, key);
}
