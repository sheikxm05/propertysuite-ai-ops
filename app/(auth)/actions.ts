'use server';

/**
 * Authentication and onboarding server actions. Lane w1-l1.
 *
 * **Why these are server actions and not route handlers.** CLAUDE.md requires every
 * route handler to go through `withApiHandler`, and `withApiHandler` authenticates and
 * then resolves membership *before* the handler runs, answering `FORBIDDEN` when there is
 * none. Every operation in this file is performed by somebody who is either not signed in
 * yet or signed in with no membership:
 *
 *   signIn / signUp / requestPasswordReset   no session at all
 *   createFirstOrganization / acceptInvite   a session, no membership
 *   signOut                                  a session that is about to end
 *
 * None of them can run under the wrapper, and writing them as unwrapped route handlers
 * would breach the rule rather than satisfy it. Server actions are a third transport:
 * they are not route handlers, so the wrapper requirement does not reach them, and they
 * can write session cookies, which a server component cannot. Raised as a planning
 * defect — the gap is in the contract, not in the implementation — and the two
 * onboarding actions call the *same* `features/organizations/rpc.ts` functions the API
 * routes call, so there is one implementation of each mutation and two ways in.
 *
 * What still holds for every action here:
 *
 *  - Input is Zod-validated against `packages/shared` before it reaches Supabase. The
 *    sign-in and sign-up schemas are local *form* schemas over email and password — not
 *    a duplicate of any shared contract, because `packages/shared` has none for
 *    credentials, deliberately: they belong to Supabase Auth, never to our tables.
 *  - Authorization for the two onboarding actions is enforced inside the
 *    security-definer RPCs, in Postgres, from `auth.uid()`. The RPCs also write their own
 *    `audit_logs` row in the same transaction, so each state change is audited exactly
 *    once whichever transport invoked it.
 *  - Nothing is logged. A password, an email address and an invitation token are all
 *    present in this file's arguments and none of them reaches a log line, an audit row
 *    or an error message.
 *  - Error text is generic by design. "Email or password is incorrect" never says which,
 *    and a password-reset request reports success whether or not the address exists —
 *    otherwise the form becomes an account-enumeration oracle.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { createServerClient } from '@/lib/supabase/server';
import {
  acceptInvitation,
  createOrganization,
  rpcFailureMessage,
} from '@/features/organizations/rpc';
import {
  currentContext,
  DASHBOARD_PATH,
  SIGN_IN_PATH,
} from '@/features/organizations/server-context';
import {
  AcceptInvitationSchema,
  CreateOrganizationSchema,
  EmailSchema,
  boundedText,
} from '@shared/index';

/* -------------------------------------------------------------------- types -- */

/**
 * What every action returns on failure.
 *
 * `fieldErrors` is exactly `ZodError.flatten().fieldErrors`, which is the shape
 * `components/ui/form.tsx` renders — amendment A1 made the form primitives
 * dependency-free around that type, so one Zod parse feeds both validation and display.
 * A successful action redirects and therefore returns nothing.
 */
export interface ActionState {
  message?: string;
  fieldErrors?: Record<string, string[] | undefined>;
  /** Set once, by `issueInvitation`'s caller. Never persisted. */
  token?: string;
}

/* ------------------------------------------------------------------ schemas -- */

/**
 * Credential schemas.
 *
 * Local to this file and not a duplication of a shared contract: `packages/shared`
 * models our *tables*, and a password is never in one. The minimum length matches
 * Supabase Auth's own default so a rejection is reported by our form rather than by a
 * provider error the user cannot act on.
 */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;

const CredentialsSchema = z
  .object({
    email: EmailSchema,
    password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
  })
  .strict();

const SignUpSchema = CredentialsSchema.extend({
  full_name: boundedText(2, 120),
}).strict();

const EmailOnlySchema = z.object({ email: EmailSchema }).strict();

/* ------------------------------------------------------------ authentication -- */

/**
 * Signs in with a password and sets the session cookie.
 *
 * `next` is validated as a relative path before it is used. An unchecked redirect target
 * here is an open redirect that hands a freshly authenticated user to another origin —
 * `middleware.ts` guards the same parameter on its own path for the same reason.
 */
export async function signIn(
  _previous: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const parsed = CredentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    return {
      message: 'Enter your email address and password.',
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    // One message for a wrong password, an unknown address and an unconfirmed account
    // alike. Distinguishing them tells an attacker which addresses are registered.
    return { message: 'Email or password is incorrect.' };
  }

  redirect(safeNext(formData.get('next')));
}

/**
 * Creates an account.
 *
 * **No profile row is inserted here.** `0003` creates it from an `auth.users` AFTER
 * INSERT trigger, and `0002` deliberately grants no client INSERT policy on `profiles` —
 * a client that could insert its own profile could choose its own `id` and pre-empt a
 * pending invitation (amendment A6). `full_name` is passed as auth user metadata, which
 * the trigger reads.
 *
 * Whether a session exists afterwards depends on the project's email-confirmation
 * setting, so both outcomes are handled rather than assumed.
 */
export async function signUp(
  _previous: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const parsed = SignUpSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    full_name: formData.get('full_name'),
  });

  if (!parsed.success) {
    return {
      message: 'Check the details below.',
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // Read by `handle_new_auth_user()` in 0003 when it creates the profile row.
      data: { full_name: parsed.data.full_name },
    },
  });

  if (error) {
    // Supabase returns a distinct error for an address that already exists. Reporting it
    // verbatim would enumerate accounts, so sign-up failures collapse to one message and
    // the detail stays server-side.
    return { message: 'That account could not be created. Try signing in instead.' };
  }

  if (!data.session) {
    return {
      message:
        'Check your inbox to confirm your email address, then sign in. ' +
        'If you were invited, you can redeem your invitation once you are signed in.',
    };
  }

  redirect(DASHBOARD_PATH);
}

/**
 * Ends the session and clears its cookies.
 *
 * `scope: 'global'` revokes every refresh token for the user, not only this browser's.
 * A local sign-out would leave a stolen refresh token valid, which is the case a
 * sign-out button most needs to cover.
 */
export async function signOut(): Promise<void> {
  const supabase = await createServerClient();
  await supabase.auth.signOut({ scope: 'global' });
  revalidatePath('/', 'layout');
  redirect(SIGN_IN_PATH);
}

/**
 * Starts a password reset.
 *
 * Always reports success. A form that said "no such account" would be a free account
 * enumeration endpoint, and the person who legitimately mistyped their address is served
 * just as well by "check your inbox".
 */
export async function requestPasswordReset(
  _previous: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const parsed = EmailOnlySchema.safeParse({ email: formData.get('email') });

  if (!parsed.success) {
    return {
      message: 'Enter a valid email address.',
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const supabase = await createServerClient();
  await supabase.auth.resetPasswordForEmail(parsed.data.email);

  return {
    message: 'If that address has an account, a reset link is on its way.',
  };
}

/* --------------------------------------------------------------- onboarding -- */

/**
 * Creates the caller's first organization and makes them its administrator.
 *
 * Validated with the frozen `CreateOrganizationSchema` — the same schema
 * `POST /api/v1/organizations` uses, so the two transports cannot accept different
 * input. `create_organization` then re-derives the caller from `auth.uid()`, creates the
 * organization and the `organization_admin` membership in one transaction, and writes its
 * own audit row.
 */
export async function createFirstOrganization(
  _previous: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const context = await currentContext();
  if (!context) return { message: 'Your session has expired. Sign in again.' };

  const parsed = CreateOrganizationSchema.safeParse({
    name: formData.get('name'),
    slug: formData.get('slug'),
  });

  if (!parsed.success) {
    return {
      message: 'Check the details below.',
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  try {
    await createOrganization(context.supabase, parsed.data);
  } catch (error) {
    return { message: rpcFailureMessage(error) ?? 'That organization could not be created.' };
  }

  revalidatePath('/', 'layout');
  redirect(DASHBOARD_PATH);
}

/**
 * Redeems an invitation token.
 *
 * The token arrives in a form body, not a URL, because a URL ends up in access logs,
 * browser history and referrer headers — `AcceptInvitationSchema` says so in
 * `packages/shared`. It is not logged here, not echoed back in an error, and not stored.
 *
 * Possession is necessary but not sufficient: `accept_invitation` requires the
 * authenticated account's email to match the invitation, so redeeming somebody else's
 * token fails even with the token in hand.
 */
export async function acceptInvite(
  _previous: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const context = await currentContext();
  if (!context) return { message: 'Sign in first, then redeem your invitation.' };

  const parsed = AcceptInvitationSchema.safeParse({
    invitation_token: formData.get('invitation_token'),
  });

  if (!parsed.success) {
    // The field error is not surfaced: it would describe the expected token length.
    return { message: 'That invitation is not valid.' };
  }

  try {
    await acceptInvitation(context.supabase, parsed.data.invitation_token);
  } catch (error) {
    return { message: rpcFailureMessage(error) ?? 'That invitation is not valid.' };
  }

  revalidatePath('/', 'layout');
  redirect(DASHBOARD_PATH);
}

/* ------------------------------------------------------------------ helpers -- */

/**
 * A relative, same-origin redirect target, or the dashboard.
 *
 * Mirrors `safeReturnTo` in `middleware.ts`. Both exist because the parameter is
 * attacker-controlled on both paths: the middleware sets it, and the form posts it back.
 * `//evil.example` is rejected along with `https://evil.example`, because a
 * protocol-relative URL is an absolute one.
 */
function safeNext(candidate: FormDataEntryValue | null): string {
  if (typeof candidate !== 'string') return DASHBOARD_PATH;
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return DASHBOARD_PATH;
  return candidate;
}
