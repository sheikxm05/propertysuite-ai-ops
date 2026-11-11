'use client';

import * as React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/components/ui/utils';

import { useTheme } from './theme-provider';
import { THEME_PREFERENCES, type ThemePreference } from './theme';

const OPTION: Readonly<
  Record<ThemePreference, { readonly label: string; readonly Icon: typeof Sun }>
> = Object.freeze({
  light: { label: 'Light', Icon: Sun },
  dark: { label: 'Dark', Icon: Moon },
  system: { label: 'System', Icon: Monitor },
});

/**
 * One-tap light ⇄ dark, for the top bar.
 *
 * Until `ready` the button shows the neutral `system` icon and a generic label, because
 * the server rendered it without knowing the stored preference. Rendering the real icon
 * before the first effect would mean the hydrated DOM disagreeing with the server's.
 *
 * The accessible name says what pressing it will DO, not what the current state is —
 * `aria-pressed` would be the wrong idiom here because this is not a two-state toggle in
 * the user's model once `system` exists.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolved, ready, toggle } = useTheme();
  const nextLabel = resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const label = ready ? nextLabel : 'Switch theme';

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label={label}
            className={cn('text-muted-foreground hover:text-foreground', className)}
          >
            {!ready ? (
              <Monitor aria-hidden="true" />
            ) : resolved === 'dark' ? (
              <Sun aria-hidden="true" />
            ) : (
              <Moon aria-hidden="true" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The full three-way choice, for inside the account menu.
 *
 * A segmented radio group rather than three menu items, because choosing a theme is the
 * one menu action a user wants to try twice without the menu closing under them. It is a
 * real `radiogroup` so arrow keys move between options.
 */
export function ThemeChoice({ className }: { className?: string }) {
  const { preference, ready, setPreference } = useTheme();

  return (
    <div className={cn('px-1 py-1', className)}>
      <p className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">Theme</p>
      <div
        role="radiogroup"
        aria-label="Theme"
        className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1"
      >
        {THEME_PREFERENCES.map((option) => {
          const { label, Icon } = OPTION[option];
          const selected = ready && preference === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setPreference(option)}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium transition-colors',
                selected
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
