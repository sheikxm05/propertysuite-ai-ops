/**
 * Database types for the `public` schema.
 *
 * ---------------------------------------------------------------------------
 * REGENERATION
 * ---------------------------------------------------------------------------
 * This file is normally generated. Regenerate it with the local Supabase stack
 * running (`npm run db:start`), from the repository root:
 *
 *   npx supabase gen types typescript --local --schema public \
 *     > packages/shared/types/database.ts
 *
 * Against a linked cloud project instead:
 *
 *   npx supabase gen types typescript --project-id <ref> --schema public \
 *     > packages/shared/types/database.ts
 *
 * It is hand-written here because Docker was unavailable when lane w0-l4 ran,
 * so the generator could not be executed. It is transcribed column by column
 * from:
 *
 *   - `supabase/migrations/0001_initial_schema.sql` (all tables, all three
 *     Postgres enums, `current_profile_id`, `is_org_member`)
 *   - `supabase/migrations/0002_rls_hardening.sql` — the six RLS helper
 *     signatures in §5.3, read directly from the migration
 *   - `supabase/migrations/0003_domain_integrity.sql` — `documents.extracted_text`
 *     and `documents.ticket_id`, the `jobs` and `organization_invitations`
 *     tables, `log_audit`, and the four security-definer RPCs. Every signature
 *     and every column below was transcribed from that file, not inferred.
 *
 * The post-`0003` schema is typed, not just the post-`0001` schema, because the
 * feature lanes that consume this file cannot add to it later.
 *
 * ---------------------------------------------------------------------------
 * CONVENTIONS — deliberately faithful to the generator, not to the domain
 * ---------------------------------------------------------------------------
 * So that a future regeneration is a no-op rather than a breaking change:
 *
 *   - A Postgres enum column is typed as its enum union (`member_role`,
 *     `ticket_status`, `ticket_priority`).
 *   - A `text` column with a `check (... in (...))` constraint is typed `string`,
 *     exactly as the generator emits it. The narrow union lives in
 *     `constants/statuses.ts` and is applied by the Zod response schemas, which
 *     are what application code should read rows through.
 *   - `numeric` is typed `number` because that is what PostgREST returns.
 *     Monetary values must not be arithmetically manipulated as numbers —
 *     parse them with `MoneyAmountSchema`, which normalizes to a fixed-scale
 *     decimal string, and do any arithmetic in integer minor units.
 *   - `date` and `timestamptz` are ISO 8601 strings.
 *
 * `Relationships` entries are required by `@supabase/postgrest-js` for nested
 * select inference; composite foreign keys are listed with all their columns.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          name: string;
          slug: string;
          status: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          status?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          status?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          auth_user_id: string;
          full_name: string;
          email: string | null;
          phone: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          auth_user_id: string;
          full_name: string;
          email?: string | null;
          phone?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          auth_user_id?: string;
          full_name?: string;
          email?: string | null;
          phone?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'profiles_auth_user_id_fkey';
            columns: ['auth_user_id'];
            isOneToOne: true;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      organization_members: {
        Row: {
          id: string;
          organization_id: string;
          profile_id: string;
          role: Database['public']['Enums']['member_role'];
          status: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          profile_id: string;
          role: Database['public']['Enums']['member_role'];
          status?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          profile_id?: string;
          role?: Database['public']['Enums']['member_role'];
          status?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'organization_members_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'organization_members_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      properties: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          property_type: string;
          address_line: string;
          city: string;
          emirate: string;
          owner_member_id: string | null;
          status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          name: string;
          property_type: string;
          address_line: string;
          city?: string;
          emirate?: string;
          owner_member_id?: string | null;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          name?: string;
          property_type?: string;
          address_line?: string;
          city?: string;
          emirate?: string;
          owner_member_id?: string | null;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'properties_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            // Composite in `0002` (§3 finding 9): a cross-organization owner
            // assignment must be structurally impossible.
            foreignKeyName: 'properties_organization_id_owner_member_id_fkey';
            columns: ['organization_id', 'owner_member_id'];
            isOneToOne: false;
            referencedRelation: 'organization_members';
            referencedColumns: ['organization_id', 'id'];
          },
        ];
      };
      property_units: {
        Row: {
          id: string;
          organization_id: string;
          property_id: string;
          unit_number: string;
          bedrooms: number | null;
          bathrooms: number | null;
          area_sqft: number | null;
          status: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          property_id: string;
          unit_number: string;
          bedrooms?: number | null;
          bathrooms?: number | null;
          area_sqft?: number | null;
          status?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          property_id?: string;
          unit_number?: string;
          bedrooms?: number | null;
          bathrooms?: number | null;
          area_sqft?: number | null;
          status?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'property_units_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'property_units_organization_id_property_id_fkey';
            columns: ['organization_id', 'property_id'];
            isOneToOne: false;
            referencedRelation: 'properties';
            referencedColumns: ['organization_id', 'id'];
          },
        ];
      };
      tenants: {
        Row: {
          id: string;
          organization_id: string;
          profile_id: string | null;
          full_name: string;
          email: string | null;
          phone: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          profile_id?: string | null;
          full_name: string;
          email?: string | null;
          phone?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          profile_id?: string | null;
          full_name?: string;
          email?: string | null;
          phone?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'tenants_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'tenants_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      tenancies: {
        Row: {
          id: string;
          organization_id: string;
          property_unit_id: string;
          tenant_id: string;
          contract_number: string | null;
          start_date: string;
          end_date: string;
          /** `numeric(12,2)`. Never do arithmetic on this as a number. */
          rent_amount: number;
          currency: string;
          status: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          property_unit_id: string;
          tenant_id: string;
          contract_number?: string | null;
          start_date: string;
          end_date: string;
          rent_amount: number | string;
          currency?: string;
          status?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          property_unit_id?: string;
          tenant_id?: string;
          contract_number?: string | null;
          start_date?: string;
          end_date?: string;
          rent_amount?: number | string;
          currency?: string;
          status?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'tenancies_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'tenancies_organization_id_property_unit_id_fkey';
            columns: ['organization_id', 'property_unit_id'];
            isOneToOne: false;
            referencedRelation: 'property_units';
            referencedColumns: ['organization_id', 'id'];
          },
          {
            foreignKeyName: 'tenancies_organization_id_tenant_id_fkey';
            columns: ['organization_id', 'tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['organization_id', 'id'];
          },
        ];
      };
      service_providers: {
        Row: {
          id: string;
          organization_id: string;
          profile_id: string | null;
          company_name: string;
          service_categories: string[];
          status: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          profile_id?: string | null;
          company_name: string;
          service_categories?: string[];
          status?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          profile_id?: string | null;
          company_name?: string;
          service_categories?: string[];
          status?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'service_providers_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'service_providers_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      maintenance_tickets: {
        Row: {
          id: string;
          organization_id: string;
          property_id: string;
          property_unit_id: string;
          tenancy_id: string | null;
          tenant_id: string;
          assigned_provider_id: string | null;
          title: string;
          description: string;
          category: string;
          priority: Database['public']['Enums']['ticket_priority'];
          status: Database['public']['Enums']['ticket_status'];
          source: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          property_id: string;
          property_unit_id: string;
          tenancy_id?: string | null;
          tenant_id: string;
          assigned_provider_id?: string | null;
          title: string;
          description: string;
          category?: string;
          priority?: Database['public']['Enums']['ticket_priority'];
          status?: Database['public']['Enums']['ticket_status'];
          source?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          property_id?: string;
          property_unit_id?: string;
          tenancy_id?: string | null;
          tenant_id?: string;
          assigned_provider_id?: string | null;
          title?: string;
          description?: string;
          category?: string;
          priority?: Database['public']['Enums']['ticket_priority'];
          status?: Database['public']['Enums']['ticket_status'];
          source?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'maintenance_tickets_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'maintenance_tickets_organization_id_property_id_fkey';
            columns: ['organization_id', 'property_id'];
            isOneToOne: false;
            referencedRelation: 'properties';
            referencedColumns: ['organization_id', 'id'];
          },
          {
            foreignKeyName: 'maintenance_tickets_organization_id_property_unit_id_fkey';
            columns: ['organization_id', 'property_unit_id'];
            isOneToOne: false;
            referencedRelation: 'property_units';
            referencedColumns: ['organization_id', 'id'];
          },
          {
            foreignKeyName: 'maintenance_tickets_organization_id_tenant_id_fkey';
            columns: ['organization_id', 'tenant_id'];
            isOneToOne: false;
            referencedRelation: 'tenants';
            referencedColumns: ['organization_id', 'id'];
          },
          {
            foreignKeyName: 'maintenance_tickets_organization_id_tenancy_id_fkey';
            columns: ['organization_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['organization_id', 'id'];
          },
          {
            foreignKeyName: 'maintenance_tickets_organization_id_assigned_provider_id_fkey';
            columns: ['organization_id', 'assigned_provider_id'];
            isOneToOne: false;
            referencedRelation: 'service_providers';
            referencedColumns: ['organization_id', 'id'];
          },
        ];
      };
      maintenance_activities: {
        Row: {
          id: string;
          organization_id: string;
          ticket_id: string;
          actor_profile_id: string | null;
          activity_type: string;
          description: string;
          metadata: Json;
          created_at: string;
        };
        /** INSERT only. `0002` revokes UPDATE and DELETE and adds a block trigger. */
        Insert: {
          id?: string;
          organization_id: string;
          ticket_id: string;
          actor_profile_id?: string | null;
          activity_type: string;
          description: string;
          metadata?: Json;
          created_at?: string;
        };
        /**
         * Present because `@supabase/postgrest-js` requires the key. The table
         * is append-only: every UPDATE is rejected by trigger, including to
         * the service role. Do not write code against this type.
         */
        Update: {
          id?: never;
          organization_id?: never;
          ticket_id?: never;
          actor_profile_id?: never;
          activity_type?: never;
          description?: never;
          metadata?: never;
          created_at?: never;
        };
        Relationships: [
          {
            foreignKeyName: 'maintenance_activities_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'maintenance_activities_organization_id_ticket_id_fkey';
            columns: ['organization_id', 'ticket_id'];
            isOneToOne: false;
            referencedRelation: 'maintenance_tickets';
            referencedColumns: ['organization_id', 'id'];
          },
          {
            foreignKeyName: 'maintenance_activities_actor_profile_id_fkey';
            columns: ['actor_profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      documents: {
        Row: {
          id: string;
          organization_id: string;
          property_id: string | null;
          tenancy_id: string | null;
          /**
           * Provider completion evidence, added by `0003` per amendment A7,
           * with the composite foreign key
           * `(organization_id, ticket_id) -> maintenance_tickets`.
           *
           * A null `ticket_id` is a tenancy contract or property document, and
           * that is exactly what keeps a service provider out of them: the A7
           * policies require `ticket_id is not null`.
           */
          ticket_id: string | null;
          document_type: string;
          storage_path: string;
          extracted_data: Json | null;
          /** Added by `0002` — §3 finding 10. Never logged. */
          extracted_text: string | null;
          verification_status: string;
          uploaded_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          property_id?: string | null;
          tenancy_id?: string | null;
          ticket_id?: string | null;
          document_type: string;
          storage_path: string;
          extracted_data?: Json | null;
          extracted_text?: string | null;
          verification_status?: string;
          uploaded_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          property_id?: string | null;
          tenancy_id?: string | null;
          ticket_id?: string | null;
          document_type?: string;
          storage_path?: string;
          extracted_data?: Json | null;
          extracted_text?: string | null;
          verification_status?: string;
          uploaded_by?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'documents_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'documents_organization_id_property_id_fkey';
            columns: ['organization_id', 'property_id'];
            isOneToOne: false;
            referencedRelation: 'properties';
            referencedColumns: ['organization_id', 'id'];
          },
          {
            foreignKeyName: 'documents_organization_id_tenancy_id_fkey';
            columns: ['organization_id', 'tenancy_id'];
            isOneToOne: false;
            referencedRelation: 'tenancies';
            referencedColumns: ['organization_id', 'id'];
          },
          {
            foreignKeyName: 'documents_organization_id_ticket_id_fkey';
            columns: ['organization_id', 'ticket_id'];
            isOneToOne: false;
            referencedRelation: 'maintenance_tickets';
            referencedColumns: ['organization_id', 'id'];
          },
          {
            foreignKeyName: 'documents_uploaded_by_fkey';
            columns: ['uploaded_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      ai_conversations: {
        Row: {
          id: string;
          organization_id: string;
          user_profile_id: string | null;
          channel: string;
          external_conversation_id: string | null;
          status: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          user_profile_id?: string | null;
          channel: string;
          external_conversation_id?: string | null;
          status?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_profile_id?: string | null;
          channel?: string;
          external_conversation_id?: string | null;
          status?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'ai_conversations_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'ai_conversations_user_profile_id_fkey';
            columns: ['user_profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      ai_messages: {
        Row: {
          id: string;
          organization_id: string;
          conversation_id: string;
          sender_type: string;
          /** Message body. Never logged. */
          content: string;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          conversation_id: string;
          sender_type: string;
          content: string;
          metadata?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          conversation_id?: string;
          sender_type?: string;
          content?: string;
          metadata?: Json;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'ai_messages_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'ai_messages_organization_id_conversation_id_fkey';
            columns: ['organization_id', 'conversation_id'];
            isOneToOne: false;
            referencedRelation: 'ai_conversations';
            referencedColumns: ['organization_id', 'id'];
          },
        ];
      };
      notifications: {
        Row: {
          id: string;
          organization_id: string;
          recipient_profile_id: string | null;
          channel: string;
          event_type: string;
          payload: Json;
          status: string;
          retry_count: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          recipient_profile_id?: string | null;
          channel: string;
          event_type: string;
          payload?: Json;
          status?: string;
          retry_count?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          recipient_profile_id?: string | null;
          channel?: string;
          event_type?: string;
          payload?: Json;
          status?: string;
          retry_count?: number;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notifications_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notifications_recipient_profile_id_fkey';
            columns: ['recipient_profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      audit_logs: {
        Row: {
          id: string;
          organization_id: string;
          actor_profile_id: string | null;
          action: string;
          entity_type: string;
          entity_id: string | null;
          metadata: Json;
          created_at: string;
        };
        /** Append-only. `0002` restricts reads to organization administrators. */
        Insert: {
          id?: string;
          organization_id: string;
          actor_profile_id?: string | null;
          action: string;
          entity_type: string;
          entity_id?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: {
          id?: never;
          organization_id?: never;
          actor_profile_id?: never;
          action?: never;
          entity_type?: never;
          entity_id?: never;
          metadata?: never;
          created_at?: never;
        };
        Relationships: [
          {
            foreignKeyName: 'audit_logs_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'audit_logs_actor_profile_id_fkey';
            columns: ['actor_profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      /**
       * Durable job runner, added by migration `0003`
       * (`docs/implementation-plan.md` §5, Sprint 1):
       * `jobs(id, type, payload, idempotency_key unique, attempts, next_run_at,
       * status, last_error)`.
       *
       * Not organization-scoped by RLS: the runner executes with the service
       * role. `payload` therefore carries only identifiers, never document text.
       */
      jobs: {
        Row: {
          id: string;
          type: string;
          payload: Json;
          idempotency_key: string | null;
          attempts: number;
          next_run_at: string | null;
          status: string;
          last_error: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          type: string;
          payload?: Json;
          idempotency_key?: string | null;
          attempts?: number;
          next_run_at?: string | null;
          status?: string;
          last_error?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          type?: string;
          payload?: Json;
          idempotency_key?: string | null;
          attempts?: number;
          next_run_at?: string | null;
          status?: string;
          last_error?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      /**
       * Pending organization invitations, added by migration `0003`
       * (amendment A4): `organization_members.profile_id` is `NOT NULL`, so an
       * invitee who has not signed up yet cannot be represented as a member.
       *
       * `token_hash` holds a SHA-256 hash of the invitation token — never the
       * token itself, so a database read cannot be replayed as an acceptance.
       * The plaintext token is returned exactly once, by `invite_member`, and
       * must never be logged. The admin SELECT policy omits the column, so a
       * client read never returns it even though it is typed here.
       */
      organization_invitations: {
        Row: {
          id: string;
          organization_id: string;
          email: string;
          role: Database['public']['Enums']['member_role'];
          /** SHA-256 hash. Never read this client-side; never log it. */
          token_hash: string;
          status: string;
          invited_by_profile_id: string | null;
          accepted_profile_id: string | null;
          expires_at: string;
          accepted_at: string | null;
          created_at: string;
        };
        /** Written only by the `invite_member` / `accept_invitation` / `revoke_invitation` RPCs. */
        Insert: {
          id?: string;
          organization_id: string;
          email: string;
          role: Database['public']['Enums']['member_role'];
          token_hash: string;
          status?: string;
          invited_by_profile_id?: string | null;
          accepted_profile_id?: string | null;
          expires_at: string;
          accepted_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          email?: string;
          role?: Database['public']['Enums']['member_role'];
          token_hash?: string;
          status?: string;
          invited_by_profile_id?: string | null;
          accepted_profile_id?: string | null;
          expires_at?: string;
          accepted_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'organization_invitations_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'organization_invitations_invited_by_profile_id_fkey';
            columns: ['invited_by_profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'organization_invitations_accepted_profile_id_fkey';
            columns: ['accepted_profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };

      /* ================================================================== */
      /* 0004 - agentic capabilities                                        */
      /* ================================================================== */

      /**
       * Retrieval index over `documents.extracted_text`.
       *
       * `embedding` is `halfvec(2048)` and is intentionally absent from Row: it is never
       * selected by the application (only compared inside `search_document_chunks`) and
       * is written as a pgvector literal string.
       */
      document_chunks: {
        Row: {
          id: string;
          organization_id: string;
          document_id: string;
          chunk_index: number;
          content: string;
          token_count: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          document_id: string;
          chunk_index: number;
          content: string;
          token_count?: number | null;
          embedding?: string;
          created_at?: string;
        };
        Update: {
          content?: string;
          token_count?: number | null;
          embedding?: string;
        };
        Relationships: [];
      };

      /**
       * The idempotency gate for inbound webhooks. `unique (provider, event_id)` is the
       * whole mechanism: a replayed delivery is rejected by Postgres with 23505 rather
       * than by application logic, so it survives concurrent retries and a cold start.
       * RLS enabled with zero policies - service role only.
       */
      webhook_events: {
        Row: {
          id: string;
          provider: string;
          event_id: string;
          payload: Json | null;
          status: string;
          received_at: string;
          processed_at: string | null;
          error: string | null;
        };
        Insert: {
          id?: string;
          provider: string;
          event_id: string;
          payload?: Json | null;
          status?: string;
          received_at?: string;
          processed_at?: string | null;
          error?: string | null;
        };
        Update: {
          status?: string;
          processed_at?: string | null;
          error?: string | null;
        };
        Relationships: [];
      };

      /**
       * A message that arrived over WhatsApp or the simulator.
       *
       * `organization_id` is NULLABLE on purpose: a number that cannot be mapped to
       * exactly one tenant stays unattributed with status `unmatched`. Guessing would
       * cross the isolation boundary this project exists to defend.
       */
      inbound_messages: {
        Row: {
          id: string;
          organization_id: string | null;
          provider: string;
          external_message_id: string;
          from_identifier: string;
          body: string;
          received_at: string;
          status: string;
          ticket_id: string | null;
        };
        Insert: {
          id?: string;
          organization_id?: string | null;
          provider: string;
          external_message_id: string;
          from_identifier: string;
          body: string;
          received_at?: string;
          status?: string;
          ticket_id?: string | null;
        };
        Update: {
          organization_id?: string | null;
          status?: string;
          ticket_id?: string | null;
        };
        Relationships: [];
      };

      agent_runs: {
        Row: {
          id: string;
          organization_id: string;
          actor_profile_id: string | null;
          input: string;
          status: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          actor_profile_id?: string | null;
          input: string;
          status?: string;
          created_at?: string;
        };
        Update: { status?: string };
        Relationships: [];
      };

      /**
       * A consequential action the model wants to take.
       *
       * There is deliberately NO client UPDATE privilege and no UPDATE policy: a
       * proposal becomes `approved` only through `approve_agent_proposal`, which checks
       * `is_org_staff()`. `Update` is declared `never` so the type system refuses what
       * the database would refuse anyway.
       */
      agent_proposals: {
        Row: {
          id: string;
          organization_id: string;
          run_id: string;
          tool_name: string;
          arguments: Json;
          rationale: string;
          status: string;
          decided_by: string | null;
          decided_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          run_id: string;
          tool_name: string;
          arguments: Json;
          rationale: string;
          status?: string;
          created_at?: string;
        };
        Update: { [_ in never]: never };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      /* ---------------------------------------------------------------- */
      /* 0001 — baseline helpers                                          */
      /* ---------------------------------------------------------------- */

      /** The caller's `profiles.id`, derived from `auth.uid()`. */
      current_profile_id: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      is_org_member: {
        Args: { target_org: string };
        Returns: boolean;
      };

      /* ---------------------------------------------------------------- */
      /* 0002 — RLS helpers, §5.3. Argument names verified against the    */
      /* migration.                                                       */
      /* ---------------------------------------------------------------- */

      has_org_role: {
        Args: { org: string; roles: Database['public']['Enums']['member_role'][] };
        Returns: boolean;
      };
      /** `organization_admin` or `property_manager`. */
      is_org_staff: {
        Args: { org: string };
        Returns: boolean;
      };
      current_tenant_id: {
        Args: { org: string };
        Returns: string;
      };
      current_provider_id: {
        Args: { org: string };
        Returns: string;
      };
      owns_property: {
        Args: { org: string; property_id: string };
        Returns: boolean;
      };
      /** True when the caller holds an active tenancy on the unit. */
      can_access_unit: {
        Args: { org: string; unit_id: string };
        Returns: boolean;
      };

      /* ---------------------------------------------------------------- */
      /* 0003 — audit writer and the security-definer RPCs.               */
      /* Signatures verified against 0003_domain_integrity.sql.           */
      /* ---------------------------------------------------------------- */

      /**
       * Writes an `audit_logs` row and returns its id. `p_organization_id` is
       * the fifth, defaulted parameter added by amendment A3 —
       * `audit_logs.organization_id` is `NOT NULL` and cannot be derived from
       * the other four arguments.
       *
       * `p_metadata` must never carry document text, message bodies, tokens or
       * personal data: `audit_logs` is append-only.
       */
      log_audit: {
        Args: {
          p_action: string;
          p_entity_type: string;
          p_entity_id: string | null;
          p_metadata?: Json;
          p_organization_id?: string | null;
        };
        Returns: string;
      };

      /**
       * Creates the organization and the caller's `organization_admin`
       * membership in one transaction. There is no client INSERT policy on
       * either table by design (§3 finding 8).
       *
       * Returns `{ id, name, slug, status, created_at }` — parse it with
       * `OrganizationSchema`.
       */
      create_organization: {
        Args: { p_name: string; p_slug: string };
        Returns: Json;
      };

      /**
       * `organization_admin` only. Issues an invitation and returns
       * `{ invitation_id, token, role, expires_at }`.
       *
       * The plaintext `token` is returned EXACTLY ONCE — the table stores only
       * a SHA-256 hash. Never log it, never write it to an audit row, and never
       * put it in a URL that is logged. Parse with `InviteMemberResultSchema`.
       */
      invite_member: {
        Args: {
          p_org: string;
          p_email: string;
          p_role: Database['public']['Enums']['member_role'];
        };
        Returns: Json;
      };

      /**
       * Accepted by the invited user only: the authenticated account's email
       * must match the invitation. Activates the membership and consumes the
       * invitation.
       *
       * Returns `{ organization_id, member_id, role }` — parse with
       * `AcceptInvitationResultSchema`.
       */
      accept_invitation: {
        Args: { p_token: string };
        Returns: Json;
      };

      /**
       * `organization_admin` only. Returns `{ invitation_id, status }`.
       * Added to the frozen set after fan-out by amendment A4: an admin who can
       * invite but never revoke is not a shippable flow.
       */
      revoke_invitation: {
        Args: { p_invitation_id: string };
        Returns: Json;
      };

      /* ---------------------------------------------------------------- */
      /* 0004 - agentic capabilities                                      */
      /* ---------------------------------------------------------------- */

      /**
       * Tenant contact details, staff only.
       *
       * Exists because 0004 revoked SELECT on `tenants.email` and `tenants.phone` for
       * EVERY role: RLS filters rows, not columns, and all five app roles share the one
       * Postgres role `authenticated`, so a service provider could otherwise read a
       * tenant contact record straight through PostgREST. Raises 42501 for a caller who
       * is not staff of the organization.
       *
       * `p_tenant_id` may be null, meaning every tenant in the organization the caller
       * may see - so a list page hydrates in one round trip rather than one per row.
       */
      tenant_contact: {
        Args: { p_organization_id: string; p_tenant_id?: string | null };
        Returns: { tenant_id: string; email: string | null; phone: string | null }[];
      };

      /** Whether the caller may read a document. Mirrors the 0002 documents policies. */
      can_read_document: {
        Args: { p_organization_id: string; p_document_id: string };
        Returns: boolean;
      };

      /**
       * Org-scoped similarity search over `document_chunks`.
       *
       * Filters by organization AND document visibility BEFORE ranking - a retriever
       * that ranks first and filters second leaks other organizations content through
       * the ranking itself. `p_query` is a pgvector literal string. Raises 28000 when
       * called with the service role, because it must run as a real principal.
       */
      search_document_chunks: {
        Args: {
          p_organization_id: string;
          p_query: string;
          p_limit: number;
          p_document_id?: string | null;
        };
        Returns: {
          chunk_id: string;
          document_id: string;
          content: string;
          distance: number;
        }[];
      };

      approve_agent_proposal: {
        Args: { p_id: string };
        Returns: Json;
      };

      reject_agent_proposal: {
        Args: { p_id: string };
        Returns: Json;
      };
    };
    Enums: {
      member_role:
        | 'organization_admin'
        | 'property_owner'
        | 'property_manager'
        | 'tenant'
        | 'service_provider';
      ticket_status:
        'open' | 'assigned' | 'in_progress' | 'awaiting_approval' | 'completed' | 'cancelled';
      ticket_priority: 'low' | 'normal' | 'high' | 'urgent';
    };
    CompositeTypes: { [_ in never]: never };
  };
};

/* -------------------------------------------------------------------------- */
/* Convenience aliases — the shapes feature lanes actually import.            */
/* -------------------------------------------------------------------------- */

export type PublicSchema = Database['public'];

export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row'];

export type TablesInsert<T extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][T]['Insert'];

export type TablesUpdate<T extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][T]['Update'];

export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T];

export type DbFunctions = PublicSchema['Functions'];

export type OrganizationRow = Tables<'organizations'>;
export type ProfileRow = Tables<'profiles'>;
export type OrganizationMemberRow = Tables<'organization_members'>;
export type PropertyRow = Tables<'properties'>;
export type PropertyUnitRow = Tables<'property_units'>;
export type TenantRow = Tables<'tenants'>;
export type TenancyRow = Tables<'tenancies'>;
export type ServiceProviderRow = Tables<'service_providers'>;
export type MaintenanceTicketRow = Tables<'maintenance_tickets'>;
export type MaintenanceActivityRow = Tables<'maintenance_activities'>;
export type DocumentRow = Tables<'documents'>;
export type AiConversationRow = Tables<'ai_conversations'>;
export type AiMessageRow = Tables<'ai_messages'>;
export type NotificationRow = Tables<'notifications'>;
export type AuditLogRow = Tables<'audit_logs'>;
export type JobRow = Tables<'jobs'>;
