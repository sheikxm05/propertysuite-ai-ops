'use client';

import * as React from 'react';

/**
 * Minimal toast store. Deliberately dependency-free: the frozen dependency list
 * (parallel-execution-plan.md §5.1) has no state library, and feature lanes must not
 * add one.
 */
const TOAST_LIMIT = 3;
const TOAST_REMOVE_DELAY = 5000;

export type ToastVariant = 'default' | 'destructive' | 'success' | 'warning';

export interface ToasterToast {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  variant?: ToastVariant;
  open: boolean;
}

type State = { toasts: ToasterToast[] };

let count = 0;
const nextId = () => {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return String(count);
};

let memoryState: State = { toasts: [] };
const listeners = new Set<(state: State) => void>();

function setState(next: State) {
  memoryState = next;
  listeners.forEach((l) => l(memoryState));
}

function dismiss(id?: string) {
  setState({
    toasts: memoryState.toasts.map((t) => (!id || t.id === id ? { ...t, open: false } : t)),
  });
}

function remove(id: string) {
  setState({ toasts: memoryState.toasts.filter((t) => t.id !== id) });
}

export function toast(props: Omit<ToasterToast, 'id' | 'open'>) {
  const id = nextId();
  setState({ toasts: [{ ...props, id, open: true }, ...memoryState.toasts].slice(0, TOAST_LIMIT) });
  setTimeout(() => dismiss(id), TOAST_REMOVE_DELAY);
  return { id, dismiss: () => dismiss(id) };
}

export function useToast() {
  const [state, setLocal] = React.useState<State>(memoryState);

  React.useEffect(() => {
    listeners.add(setLocal);
    return () => {
      listeners.delete(setLocal);
    };
  }, []);

  return { ...state, toast, dismiss, remove };
}
