/**
 * The single import seam between `lib/**` and the frozen contracts package.
 *
 * Why this file exists, and why it is not a duplicate of anything:
 *
 * `docs/parallel-execution-plan.md` §5.4 freezes the *export names* that
 * `packages/shared` must provide, but not the *module paths* they live at. W0-L4 wrote
 * that package concurrently with this lane, so `lib/**` was coded blind against the
 * frozen names. Routing every `lib/**` import through here meant exactly one file had to
 * change when the package landed, rather than a dozen.
 *
 * It re-exports. It defines nothing. CLAUDE.md rule 4 forbids a local copy of a shared
 * type, schema, enum or error code, and there is none below — in particular the error
 * code union, the status table, the message table and the SQLSTATE table all come from
 * `packages/shared/constants/errors`, so `lib/api/errors.ts` owns the *behaviour* of an
 * error and `packages/shared` owns its *data*. Two tables would be two chances to drift.
 */

/* Identity -------------------------------------------------------------------- */

export type { MemberRole } from '@shared/index';

/* The error contract (§5.2) ---------------------------------------------------- */

export {
  ERROR_CODES,
  ERROR_MESSAGES,
  ERROR_STATUS,
  SQLSTATE_ERROR_CODES,
  errorCodeForSqlState,
  isErrorCode,
  statusForErrorCode,
} from '@shared/index';
export type { ApiError, ApiErrorDetail, ErrorCode } from '@shared/index';

/* The list response envelope (§5.7, amendment A18) ----------------------------- */

export {
  MAX_PAGE_SIZE,
  PageInfoSchema,
  listResponseSchema,
  resourceResponseSchema,
} from '@shared/index';
export type { PageInfo } from '@shared/index';

/* Generated database row types ------------------------------------------------ */

export type { Database, Json } from '@shared/index';
