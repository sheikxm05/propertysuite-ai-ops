import * as React from 'react';
import { cn } from './utils';

/**
 * Table density and alignment.
 *
 * Two decisions are made here once, rather than at every call site:
 *
 *  - **Density.** Header and body cells share one horizontal rhythm (`px-3`) and a row
 *    height tall enough to be hit on a touch screen without the table turning into a
 *    list. Five feature tables each choosing their own padding is how a product starts
 *    looking assembled rather than designed.
 *  - **Numerals.** `numeric` right-aligns a column and switches it to tabular, slashed
 *    figures. Proportional digits make a column of money or counts impossible to compare
 *    down the page, because the digits do not line up vertically.
 *
 * `numeric` is an optional boolean prop rather than a class at the call site so the
 * alignment and the numeral style can never be applied to only half of a column.
 */

interface NumericProps {
  /** Right-align and use tabular figures. For money, counts, dates and identifiers. */
  numeric?: boolean;
}

const Table = React.forwardRef<HTMLTableElement, React.ComponentProps<'table'>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-auto">
      <table
        ref={ref}
        className={cn('w-full caption-bottom border-collapse text-sm', className)}
        {...props}
      />
    </div>
  ),
);
Table.displayName = 'Table';

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.ComponentProps<'thead'>>(
  ({ className, ...props }, ref) => (
    <thead ref={ref} className={cn('[&_tr]:border-b', className)} {...props} />
  ),
);
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<HTMLTableSectionElement, React.ComponentProps<'tbody'>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
  ),
);
TableBody.displayName = 'TableBody';

const TableFooter = React.forwardRef<HTMLTableSectionElement, React.ComponentProps<'tfoot'>>(
  ({ className, ...props }, ref) => (
    <tfoot
      ref={ref}
      className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  ),
);
TableFooter.displayName = 'TableFooter';

const TableRow = React.forwardRef<HTMLTableRowElement, React.ComponentProps<'tr'>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        'border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = 'TableRow';

const TableHead = React.forwardRef<HTMLTableCellElement, React.ComponentProps<'th'> & NumericProps>(
  ({ className, numeric, scope, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        'h-11 px-3 text-left align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground',
        '[&:has([role=checkbox])]:pr-0',
        numeric && 'text-right',
        className,
      )}
      {...props}
      // A column header without a scope is ambiguous to a screen reader once a table has
      // row headers too. Callers may override it; they may not omit it.
      scope={scope ?? 'col'}
    />
  ),
);
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef<HTMLTableCellElement, React.ComponentProps<'td'> & NumericProps>(
  ({ className, numeric, ...props }, ref) => (
    <td
      ref={ref}
      className={cn(
        'px-3 py-2.5 align-middle [&:has([role=checkbox])]:pr-0',
        numeric && 'numeric text-right',
        className,
      )}
      {...props}
    />
  ),
);
TableCell.displayName = 'TableCell';

const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.ComponentProps<'caption'>>(
  ({ className, ...props }, ref) => (
    <caption ref={ref} className={cn('mt-4 text-sm text-muted-foreground', className)} {...props} />
  ),
);
TableCaption.displayName = 'TableCaption';

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
