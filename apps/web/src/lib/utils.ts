import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function formatCredits(n: number | null | undefined) {
  return new Intl.NumberFormat('en-US').format(n ?? 0);
}

export function formatUsd(n: number | null | undefined, digits = 2) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n ?? 0);
}

export function timeAgo(iso: string | Date) {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return d.toLocaleDateString();
}

export function seconds(n: number) {
  return n >= 60 ? `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, '0')}` : `${Math.round(n * 10) / 10}s`;
}
