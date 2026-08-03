'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ThemeToggle() {
  const { setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  // The server cannot know the resolved theme, so the icon is only rendered after
  // mount to avoid a hydration mismatch.
  React.useEffect(() => setMounted(true), []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Change colour theme">
          {mounted ? (
            <>
              <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            </>
          ) : (
            <Sun className="size-4 opacity-0" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <Sun className="size-4" /> Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <Moon className="size-4" /> Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <Monitor className="size-4" /> System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
