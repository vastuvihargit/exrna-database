/**
 * The inventory rules that decide whether stock can be issued.
 *
 * These are pure functions with the clock passed in, which is the whole reason they are
 * pure: "expired" is the rule that stops somebody handing over a reagent that is no longer
 * fit to use, and a rule that can only be exercised through a database fixture is a rule
 * that mostly does not get exercised.
 *
 * `summarizeBatches` is here for a different reason. The item's `availableQuantity` is a
 * denormalized copy of the batch totals, and a denormalized copy that drifts is worse than
 * no copy at all — it would report stock the shelf does not hold.
 */
import { describe, expect, it } from 'vitest';

import {
  expiryStateFor,
  isBatchIssuable,
  nearExpiryCutoff,
  stockStateFor,
  summarizeBatches,
  NEAR_EXPIRY_DAYS,
} from '@/server/domain/inventory';

const NOW = new Date('2026-08-03T12:00:00.000Z');

function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);
}

describe('stock state', () => {
  it('reports out of stock at zero and below', () => {
    expect(stockStateFor(0, 5)).toBe('out_of_stock');
    // Negative should be unreachable, but if a counter ever drifted the answer must not be
    // "in stock".
    expect(stockStateFor(-1, 5)).toBe('out_of_stock');
  });

  it('treats the minimum itself as low, not as ok', () => {
    // A minimum stock level is the point at which you reorder. Reporting "ok" at exactly
    // that level means the alert only fires once you are already below it.
    expect(stockStateFor(5, 5)).toBe('low');
    expect(stockStateFor(4.999, 5)).toBe('low');
    expect(stockStateFor(5.001, 5)).toBe('ok');
  });

  it('never reports low when no minimum has been set', () => {
    expect(stockStateFor(1, 0)).toBe('ok');
  });
});

describe('expiry state', () => {
  it('says nothing about stock with no expiry date', () => {
    expect(expiryStateFor(null, NOW)).toBe('none');
    expect(expiryStateFor(undefined, NOW)).toBe('none');
  });

  it('is expired strictly in the past', () => {
    expect(expiryStateFor(new Date(NOW.getTime() - 1), NOW)).toBe('expired');
    // The expiry instant itself has not passed yet.
    expect(expiryStateFor(NOW, NOW)).toBe('near_expiry');
  });

  it('flags the near-expiry window inclusively at both ends', () => {
    expect(expiryStateFor(daysFromNow(1), NOW)).toBe('near_expiry');
    expect(expiryStateFor(daysFromNow(NEAR_EXPIRY_DAYS), NOW)).toBe('near_expiry');
    expect(expiryStateFor(daysFromNow(NEAR_EXPIRY_DAYS + 1), NOW)).toBe('ok');
  });

  it('honours a custom window', () => {
    expect(expiryStateFor(daysFromNow(45), NOW, 60)).toBe('near_expiry');
    expect(expiryStateFor(daysFromNow(45), NOW, 30)).toBe('ok');
  });

  it('computes the cutoff the filters use from the same window', () => {
    expect(nearExpiryCutoff(NOW).getTime()).toBe(daysFromNow(NEAR_EXPIRY_DAYS).getTime());
  });
});

describe('batch issuability', () => {
  it('refuses an empty batch', () => {
    expect(isBatchIssuable({ batchNumber: 'A', quantity: 0, expiryDate: null }, NOW)).toBe(false);
  });

  it('refuses an expired batch even when it still holds stock', () => {
    expect(
      isBatchIssuable({ batchNumber: 'A', quantity: 500, expiryDate: daysFromNow(-1) }, NOW),
    ).toBe(false);
  });

  it('allows stock that is near expiry — near is not past', () => {
    expect(
      isBatchIssuable({ batchNumber: 'A', quantity: 500, expiryDate: daysFromNow(2) }, NOW),
    ).toBe(true);
  });

  it('allows undated stock', () => {
    expect(isBatchIssuable({ batchNumber: 'A', quantity: 1, expiryDate: null }, NOW)).toBe(true);
  });
});

describe('batch summary', () => {
  it('reports an empty item as empty', () => {
    expect(summarizeBatches([])).toEqual({
      availableQuantity: 0,
      batchNumber: '',
      expiryDate: null,
    });
  });

  it('sums only batches that still hold stock', () => {
    const summary = summarizeBatches([
      { batchNumber: 'A', quantity: 100, expiryDate: daysFromNow(90) },
      { batchNumber: 'B', quantity: 0, expiryDate: daysFromNow(10) },
      { batchNumber: 'C', quantity: 50.5, expiryDate: daysFromNow(60) },
    ]);
    expect(summary.availableQuantity).toBe(150.5);
    // B is empty, so it must not be nominated as the next batch out despite expiring first.
    expect(summary.batchNumber).toBe('C');
    expect(summary.expiryDate).toEqual(daysFromNow(60));
  });

  it('nominates the earliest expiry, whatever order the batches are in', () => {
    const summary = summarizeBatches([
      { batchNumber: 'LATE', quantity: 10, expiryDate: daysFromNow(120) },
      { batchNumber: 'SOON', quantity: 10, expiryDate: daysFromNow(3) },
      { batchNumber: 'MID', quantity: 10, expiryDate: daysFromNow(40) },
    ]);
    expect(summary.batchNumber).toBe('SOON');
    expect(summary.expiryDate).toEqual(daysFromNow(3));
  });

  it('prefers a dated batch over an undated one', () => {
    // First-expiry-first-out: the batch with a deadline is the one to consume, otherwise it
    // is the one that ends up being thrown away.
    const summary = summarizeBatches([
      { batchNumber: 'NODATE', quantity: 10, expiryDate: null },
      { batchNumber: 'DATED', quantity: 10, expiryDate: daysFromNow(200) },
    ]);
    expect(summary.batchNumber).toBe('DATED');
  });

  it('falls back to an undated batch when nothing dated is in stock', () => {
    const summary = summarizeBatches([
      { batchNumber: 'NODATE', quantity: 10, expiryDate: null },
      { batchNumber: 'DATED', quantity: 0, expiryDate: daysFromNow(5) },
    ]);
    expect(summary.availableQuantity).toBe(10);
    expect(summary.batchNumber).toBe('NODATE');
    expect(summary.expiryDate).toBeNull();
  });

  it('still nominates expired stock as the next batch out', () => {
    // Deliberate: the summary describes what is on the shelf, not what may be issued. The
    // expiry rule is enforced at issue time, and an item whose earliest date is in the past
    // is exactly what the "expired" alert needs to find.
    const summary = summarizeBatches([
      { batchNumber: 'OLD', quantity: 5, expiryDate: daysFromNow(-10) },
      { batchNumber: 'NEW', quantity: 5, expiryDate: daysFromNow(10) },
    ]);
    expect(summary.batchNumber).toBe('OLD');
    expect(expiryStateFor(summary.expiryDate, NOW)).toBe('expired');
  });
});
