'use client';

import * as React from 'react';
import { Label } from './label';
import { cn } from './utils';

/**
 * FREEZE AMENDMENT (W0-L1, recorded in parallel-execution-plan.md §5.6).
 *
 * shadcn/ui's canonical `form` component requires react-hook-form and
 * @hookform/resolvers, neither of which is in the frozen dependency list (§5.1), and no
 * lane may install a dependency. So these primitives are deliberately dependency-free:
 * they render a native <form>, and field errors arrive as a plain
 * Record<string, string[]> — exactly the shape `ZodError.flatten().fieldErrors`
 * produces.
 *
 * Feature lanes therefore keep ONE Zod schema from packages/shared for both sides:
 *
 *   const [state, action] = useActionState(createProperty, null);
 *   <Form action={action} errors={state?.fieldErrors}>
 *     <FormField name="name">
 *       <FormLabel required>Property name</FormLabel>
 *       <FormControl><Input name="name" /></FormControl>
 *       <FormMessage />
 *     </FormField>
 *   </Form>
 *
 * Server-side validation remains authoritative. These components only display what the
 * server returned; they never decide whether input is acceptable.
 */

export type FieldErrors = Record<string, string[] | undefined>;

interface FormContextValue {
  errors: FieldErrors;
}
const FormContext = React.createContext<FormContextValue>({ errors: {} });

interface FieldContextValue {
  name: string;
  id: string;
  messageId: string;
  descriptionId: string;
  errors: string[];
}
const FieldContext = React.createContext<FieldContextValue | null>(null);

function useField(): FieldContextValue {
  const ctx = React.useContext(FieldContext);
  if (!ctx) throw new Error('Form subcomponents must be used inside <FormField name="...">');
  return ctx;
}

export interface FormProps extends React.ComponentProps<'form'> {
  /** Field errors from the server, e.g. ZodError.flatten().fieldErrors */
  errors?: FieldErrors | null;
}

const Form = React.forwardRef<HTMLFormElement, FormProps>(
  ({ errors, className, children, ...props }, ref) => (
    <FormContext.Provider value={{ errors: errors ?? {} }}>
      <form ref={ref} noValidate className={cn('space-y-6', className)} {...props}>
        {children}
      </form>
    </FormContext.Provider>
  ),
);
Form.displayName = 'Form';

function FormField({
  name,
  className,
  children,
}: {
  name: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { errors } = React.useContext(FormContext);
  const id = React.useId();
  const value = React.useMemo<FieldContextValue>(
    () => ({
      name,
      id: `${id}-${name}`,
      messageId: `${id}-${name}-message`,
      descriptionId: `${id}-${name}-description`,
      errors: errors[name] ?? [],
    }),
    [errors, id, name],
  );

  return (
    <FieldContext.Provider value={value}>
      <div className={cn('space-y-2', className)}>{children}</div>
    </FieldContext.Provider>
  );
}

const FormLabel = React.forwardRef<
  React.ComponentRef<typeof Label>,
  React.ComponentPropsWithoutRef<typeof Label>
>(({ className, ...props }, ref) => {
  const field = useField();
  return (
    <Label
      ref={ref}
      htmlFor={field.id}
      className={cn(field.errors.length > 0 && 'text-destructive', className)}
      {...props}
    />
  );
});
FormLabel.displayName = 'FormLabel';

/**
 * Wires accessibility attributes onto the single input it wraps, so a screen reader
 * announces the error rather than only showing it visually.
 */
function FormControl({ children }: { children: React.ReactElement }) {
  const field = useField();
  const invalid = field.errors.length > 0;

  return React.cloneElement(children, {
    id: field.id,
    name: (children.props as { name?: string }).name ?? field.name,
    'aria-invalid': invalid || undefined,
    'aria-describedby': invalid ? field.messageId : field.descriptionId,
  } as React.HTMLAttributes<HTMLElement>);
}

function FormDescription({ className, ...props }: React.ComponentProps<'p'>) {
  const field = useField();
  return (
    <p
      id={field.descriptionId}
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

/** Renders the server's error for this field. Silent when the field is valid. */
function FormMessage({ className, children, ...props }: React.ComponentProps<'p'>) {
  const field = useField();
  const body = children ?? field.errors[0];
  if (!body) return null;

  return (
    <p
      id={field.messageId}
      role="alert"
      aria-live="polite"
      className={cn('text-sm font-medium text-destructive', className)}
      {...props}
    >
      {body}
    </p>
  );
}

/** Non-field-specific errors — the `formErrors` half of a flattened ZodError. */
function FormRootError({ errors, className }: { errors?: string[]; className?: string }) {
  if (!errors?.length) return null;
  return (
    <div
      role="alert"
      className={cn(
        'rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive',
        className,
      )}
    >
      {errors[0]}
    </div>
  );
}

export {
  Form,
  FormField,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
  FormRootError,
  useField,
};
