/**
 * Alerting.
 *
 * The system checks in `system-checks.ts` decide what is wrong. This decides who finds
 * out, and — more importantly — how often. Three rules shape it:
 *
 *   1. **A condition alerts once, then goes quiet.** The disk being 92% full is one
 *      piece of news, not one every five minutes. Repeats are suppressed for a cooldown
 *      window that scales with severity.
 *   2. **Escalation always gets through.** A warning that becomes critical re-alerts
 *      immediately regardless of cooldown, because it is genuinely new information.
 *   3. **Recovery is reported.** Silence is ambiguous — it means either "fixed" or
 *      "the monitor stopped running". Saying so explicitly removes the ambiguity.
 *
 * Delivery is deliberately dependency-free: a structured log line (always — Docker
 * collects stdout and any log shipper can match on `alert: true`) plus an optional
 * webhook POST for Slack/Teams/PagerDuty-style endpoints. Adding SMTP would mean a mail
 * client in the runtime image for a job that a webhook already does.
 *
 * Nothing here is user-facing, so no alert body ever contains a filename, a folder path
 * or an employee's name — only counts and system conditions.
 */
import { AlertStateModel } from '@/server/db/models/alert-state.model';
import { getEnv } from '@/server/config/env';
import { getLogger } from '@/server/logging/logger';
import type { Severity, SystemCheck } from '@/server/services/system-checks';

export interface AlertOutcome {
  key: string;
  severity: Severity;
  /** What was done: a new alert, a re-alert on escalation, a recovery, or nothing. */
  action: 'sent' | 'escalated' | 'recovered' | 'suppressed';
  detail: string;
}

export interface DispatchOptions {
  /** Overridable for tests; defaults to now. */
  now?: Date;
  /** Skip delivery and only compute what would be sent. */
  dryRun?: boolean;
}

/** A critical condition repeats sooner than a warning: it is meant to interrupt. */
const COOLDOWN_MINUTES: Record<Exclude<Severity, 'ok'>, number> = {
  critical: 60,
  warning: 12 * 60,
};

const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Compares the current checks against what has already been sent and delivers the
 * difference. Returns one outcome per check that was acted on, including suppressions —
 * a monitor that cannot explain why it stayed silent is not much of a monitor.
 */
export async function dispatchAlerts(
  checks: readonly SystemCheck[],
  options: DispatchOptions = {},
): Promise<AlertOutcome[]> {
  const now = options.now ?? new Date();
  const outcomes: AlertOutcome[] = [];

  for (const check of checks) {
    const existing = await AlertStateModel.findOne({ key: check.key }).lean();

    if (check.severity === 'ok') {
      // Recovery: only interesting if something was actually firing.
      if (existing && !existing.resolvedAt) {
        await AlertStateModel.updateOne({ key: check.key }, { $set: { resolvedAt: now } });
        const outcome: AlertOutcome = {
          key: check.key,
          severity: 'ok',
          action: 'recovered',
          detail: `${check.label} is healthy again: ${check.detail}`,
        };
        outcomes.push(outcome);
        if (!options.dryRun) await deliver(check, outcome, now);
      }
      continue;
    }

    const severity = check.severity;
    const previouslyFiring = existing && !existing.resolvedAt;
    const escalated = previouslyFiring && existing.severity === 'warning' && severity === 'critical';
    const cooldownMs = COOLDOWN_MINUTES[severity] * 60_000;
    const withinCooldown =
      previouslyFiring && now.getTime() - existing.lastSentAt.getTime() < cooldownMs;

    if (previouslyFiring && withinCooldown && !escalated) {
      // Still broken, already reported, not yet worse. Count it and stay quiet.
      await AlertStateModel.updateOne(
        { key: check.key },
        { $inc: { occurrences: 1 }, $set: { lastDetail: check.detail } },
      );
      outcomes.push({
        key: check.key,
        severity,
        action: 'suppressed',
        detail: `Still firing; next alert after the ${COOLDOWN_MINUTES[severity]} minute cooldown.`,
      });
      continue;
    }

    await AlertStateModel.updateOne(
      { key: check.key },
      {
        $set: {
          severity,
          lastSentAt: now,
          lastDetail: check.detail,
          resolvedAt: null,
        },
        $inc: { occurrences: 1 },
        $setOnInsert: { key: check.key },
      },
      { upsert: true },
    );

    const outcome: AlertOutcome = {
      key: check.key,
      severity,
      action: escalated ? 'escalated' : 'sent',
      detail: check.detail,
    };
    outcomes.push(outcome);
    if (!options.dryRun) await deliver(check, outcome, now);
  }

  return outcomes;
}

/**
 * Sends one alert.
 *
 * The log line always happens; the webhook is best-effort. A webhook that is down must
 * not take the monitor down with it — the disk is still filling up either way, and the
 * log line has already recorded it.
 */
async function deliver(check: SystemCheck, outcome: AlertOutcome, now: Date): Promise<void> {
  const env = getEnv();
  const logger = getLogger();
  const payload = {
    alert: true,
    alertKey: check.key,
    severity: outcome.severity,
    action: outcome.action,
    label: check.label,
    detail: check.detail,
    ...(check.value ? { value: check.value } : {}),
    at: now.toISOString(),
  };

  if (outcome.severity === 'critical') logger.error(payload, `ALERT: ${check.label}`);
  else if (outcome.severity === 'warning') logger.warn(payload, `ALERT: ${check.label}`);
  else logger.info(payload, `RECOVERED: ${check.label}`);

  const url = env.ALERT_WEBHOOK_URL;
  if (!url) return;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `text` is what chat webhooks render; the structured fields are for anything
        // that parses. Both, so one payload works with either kind of endpoint.
        body: JSON.stringify({
          text: `[${outcome.severity.toUpperCase()}] ${env.APP_NAME}: ${check.label} — ${check.detail}`,
          ...payload,
          environment: env.NODE_ENV,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    logger.error({ err: error, alertKey: check.key }, 'Could not deliver alert to the webhook');
  }
}

/** Test hook: drops all cooldown state. */
export async function resetAlertState(): Promise<void> {
  await AlertStateModel.deleteMany({});
}

export const alertService = { dispatchAlerts, resetAlertState };
