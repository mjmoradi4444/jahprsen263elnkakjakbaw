import { getSetting, setSetting } from './db';
import type { OrderRecord } from '../src/shared/types';

/**
 * SLA: "customer confirmation time" — from the sales manager approving the proforma (stage 2 → 3)
 * until the sales rep registers the customer's confirmation and sends it to accounting (3 → 4).
 *
 * Everything is derived from each order's stage history, so it also works for orders created
 * before this metric existed. One order can have several cycles (e.g. customer rejects, the rep
 * revises, the manager approves again).
 */

export const MGR_APPROVE_ACTION = 'تایید مدیر فروش';
export const CUSTOMER_CONFIRM_ACTION = 'ثبت تاییدیه مشتری';
const RETURN_ACTION_PREFIX = 'برگشت سفارش';

const SETTING_KEY = 'sla_customer_confirm_hours';
export const DEFAULT_CONFIRM_TARGET_HOURS = 24;

export function getConfirmTargetHours(): number {
  const v = Number(getSetting(SETTING_KEY));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_CONFIRM_TARGET_HOURS;
}

export function setConfirmTargetHours(hours: number): number {
  const clean = Math.round(hours * 10) / 10;
  setSetting(SETTING_KEY, String(clean));
  return clean;
}

export interface ConfirmCycle {
  orderId: string;
  proforma: string;
  customer: string;
  salesOwnerId: string;
  salesOwnerName: string;
  startedAt: string; // sales manager approval
  endedAt: string | null;
  outcome: 'confirmed' | 'rejected' | 'open';
  hours: number; // elapsed (for open cycles: until "now")
}

const H = 3_600_000;

export function confirmCycles(o: OrderRecord, now: Date = new Date()): ConfirmCycle[] {
  const out: ConfirmCycle[] = [];
  let start: string | null = null;
  const base = {
    orderId: o.id,
    proforma: o.proforma,
    customer: o.customer,
    salesOwnerId: o.salesOwnerId,
    salesOwnerName: o.salesOwnerName,
  };
  const close = (endedAt: string, outcome: 'confirmed' | 'rejected') => {
    if (!start) return;
    out.push({ ...base, startedAt: start, endedAt, outcome, hours: (Date.parse(endedAt) - Date.parse(start)) / H });
    start = null;
  };
  for (const h of o.stageHistory) {
    if (h.stage === 2 && h.action === MGR_APPROVE_ACTION) start = h.timestamp;
    else if (h.stage === 3 && h.action === CUSTOMER_CONFIRM_ACTION) close(h.timestamp, 'confirmed');
    else if (h.stage === 3 && (h.action || '').startsWith(RETURN_ACTION_PREFIX)) close(h.timestamp, 'rejected');
  }
  if (start && o.stage === 3 && o.status === 'active') {
    out.push({ ...base, startedAt: start, endedAt: null, outcome: 'open', hours: (now.getTime() - Date.parse(start)) / H });
  }
  return out;
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
