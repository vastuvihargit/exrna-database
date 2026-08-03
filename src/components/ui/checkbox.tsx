'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A native checkbox rather than a Radix one.
 *
 * Selection checkboxes sit inside rows that are themselves draggable and clickable, and a
 * real `<input type="checkbox">` brings the platform's own behaviour with it — the space
 * key, form semantics, and the indeterminate state screen readers announce as "mixed".
 * `indeterminate` is a DOM property with no HTML attribute, so it has to be set on the
 * element; that is the only reason for the ref plumbing here.
 */
export const Checkbox = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & { indeterminate?: boolean }
>(({ className, indeterminate = false, ...props }, forwardedRef) => {
  const innerRef = React.useRef<HTMLInputElement>(null);

  React.useImperativeHandle(forwardedRef, () => innerRef.current as HTMLInputElement);

  React.useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={innerRef}
      type="checkbox"
      className={cn(
        'size-4 shrink-0 cursor-pointer rounded border-input text-primary accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
Checkbox.displayName = 'Checkbox';
