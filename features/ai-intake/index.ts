/**
 * `features/ai-intake` — public surface. Lane w1-l5.
 *
 * The panel is exported so that whichever lane owns the `/maintenance/report` page can
 * mount it without reaching into this directory's internals. That page lives under
 * `app/(dashboard)/maintenance/**`, which belongs to lane w1-l4; this lane cannot create
 * it, so the component is delivered ready to mount and the gap is reported as a planning
 * defect.
 *
 * Mounting it is one line:
 *
 *     import { ReportIssuePanel } from '@/features/ai-intake';
 *     export default function Page() { return <ReportIssuePanel />; }
 *
 * Pass `units` when the page already knows the caller's tenancies; omit it and the server
 * resolves the unit from the session, asking for clarification when the caller holds more
 * than one.
 */

export {
  ReportIssuePanel,
  type ReportableUnit,
  type ReportIssuePanelProps,
} from './report-issue-panel';
export { navEntry } from './nav';
export { widget } from './widget';
