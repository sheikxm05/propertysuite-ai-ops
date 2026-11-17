import { MessageCircleQuestion } from 'lucide-react';
import type { NavEntry } from '@/config/types';

/**
 * Retrieval-augmented question answering over property documents, with citations.
 *
 * Every role that can read a document can ask about one — `search_document_chunks`
 * filters by organization AND per-document visibility BEFORE ranking, so a tenant asking
 * a question reaches only their own tenancy contract. A service_provider is excluded:
 * the matrix gives them no document access except assigned-ticket evidence, so the page
 * would be empty for them.
 */
export const navEntry: NavEntry = {
  key: 'ask',
  label: 'Ask',
  href: '/ask',
  icon: MessageCircleQuestion,
  roles: ['organization_admin', 'property_manager', 'property_owner', 'tenant'],
  order: 80,
  enabled: true,
};
