'use client';

import { useQuery } from '@tanstack/react-query';

/**
 * Data hooks are the only place the UI calls the API. Components never fetch directly.
 * Mirrors the server-side HealthReport shape (src/server/health/health-service.ts).
 */
export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  uptimeSeconds: number;
  environment: string;
  checks: {
    database: { status: 'ok' | 'error'; latencyMs?: number; database?: string; error?: string };
    storage: {
      status: 'ok' | 'degraded' | 'error';
      provider: string;
      writable: boolean;
      totalBytes?: number;
      freeBytes?: number;
      freePercent?: number;
      belowFreeSpaceFloor?: boolean;
      error?: string;
    };
  };
}

async function fetchHealth(): Promise<HealthReport> {
  const response = await fetch('/api/health/ready', { cache: 'no-store' });
  const body = (await response.json()) as { data?: HealthReport; error?: { message: string } };

  // 503 still carries a full report — an unhealthy system is data, not a failure to render.
  if (body.data) return body.data;
  throw Object.assign(new Error(body.error?.message ?? 'Health check failed'), {
    status: response.status,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}
