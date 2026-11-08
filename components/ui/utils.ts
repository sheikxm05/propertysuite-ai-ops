import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names, resolving Tailwind conflicts so a caller's override wins.
 * Every primitive in components/ui uses it; feature lanes should too.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
