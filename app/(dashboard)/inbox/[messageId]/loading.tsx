import { DetailSkeleton } from '../../_states/route-states';

/** Shape only — never a placeholder guess at what the message says. */
export default function Loading() {
  return <DetailSkeleton label="Loading the message…" />;
}
