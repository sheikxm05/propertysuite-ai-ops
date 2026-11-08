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
 *   - `docs/implementation-plan.md` §3 finding 10 — `documents.extracted_text`,
 *     added by migration `0002`
 *   - `docs/implementation-plan.md` §5 Sprint 1 — the `jobs` table and the
 *     three `security definer` RPCs, added by migration `0003`
 *   - `docs/parallel-execution-plan.md` §5.3 — the six RLS helper signatures
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
          idempotency_key: string;
          attempts: number;
          next_run_at: string;
          status: string;
          last_error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          type: string;
          payload?: Json;
          idempotency_key: string;
          attempts?: number;
          next_run_at?: string;
          status?: string;
          last_error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          type?: string;
          payload?: Json;
          idempotency_key?: string;
          attempts?: number;
          next_run_at?: string;
          status?: string;
          last_error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      /** `0001`. The caller's `profiles.id`, derived from `auth.uid()`. */
      current_profile_id: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      /** `0001`. */
      is_org_member: {
        Args: { target_org: string };
        Returns: boolean;
      };
      /** `0002` — §5.3. */
      has_org_role: {
        Args: { org: string; roles: Database['public']['Enums']['member_role'][] };
        Returns: boolean;
      };
      /** `0002` — §5.3. `organization_admin` or `property_manager`. */
      is_org_staff: {
        Args: { org: string };
        Returns: boolean;
      };
      /** `0002` — §5.3. */
      current_tenant_id: {
        Args: { org: string };
        Returns: string;
      };
      /** `0002` — §5.3. */
      current_provider_id: {
        Args: { org: string };
        Returns: string;
      };
      /** `0002` — §5.3. */
      owns_property: {
        Args: { org: string; property_id: string };
        Returns: boolean;
      };
      /** `0002` — §5.3. True when the caller holds an active tenancy on the unit. */
      can_access_unit: {
        Args: { org: string; unit_id: string };
        Returns: boolean;
      };
      /**
       * `0003` — `security definer` onboarding RPC. Creates the organization
       * and the caller's `organization_admin` membership in one transaction.
       *
       * PROVISIONAL: the three RPC signatures below are not frozen in
       * `docs/parallel-execution-plan.md` §5 (§5.3 freezes only the six RLS
       * helpers), so they are typed from `docs/implementation-plan.md` §5
       * Sprint 1 and reported as a planning defect by lane w0-l4. Regenerate
       * this file once `0003` has merged.
       */
      create_organization: {
        Args: { org_name: string; org_slug: string };
        Returns: string;
      };
      /** `0003` — `security definer`. Issues an invitation. PROVISIONAL, see above. */
      invite_member: {
        Args: {
          org: string;
          invitee_email: string;
          invitee_role: Database['public']['Enums']['member_role'];
        };
        Returns: string;
      };
      /** `0003` — `security definer`. Binds the caller to a pending invitation. PROVISIONAL, see above. */
      accept_invitation: {
        Args: { invitation_token: string };
        Returns: string;
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
        | 'open'
        | 'assigned'
        | 'in_progress'
        | 'awaiting_approval'
        | 'completed'
        | 'cancelled';
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
