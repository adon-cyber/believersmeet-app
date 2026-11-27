-- BelieversMeet database-local platform administrator identity.
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE IF NOT EXISTS private.platform_admins (
    user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
ALTER TABLE private.platform_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.platform_admins
    FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.is_platform_admin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM private.platform_admins AS pa
        WHERE pa.user_id = p_user_id
    );
$function$;
REVOKE ALL ON FUNCTION public.is_platform_admin(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
-- BELIEVERSMEET STAGING FOUNDATION
-- DRAFT ONLY: DO NOT EXECUTE YET.
-- Generated from the preserved schema export.
-- RLS policies and object-level grants are intentionally omitted.
-- Trigger creation is deferred until after function creation.
-- Auth and Storage system tables are intentionally excluded.


-- ===== private/schema.sql =====
CREATE SCHEMA IF NOT EXISTS "private";
-- ===== public/schema.sql =====
COMMENT ON SCHEMA "public" IS 'standard public schema';
-- ===== DEFAULT PRIVILEGE CLEANUP =====
-- Global default: remove PUBLIC EXECUTE for future functions created by postgres.
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres"
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON FUNCTIONS FROM PUBLIC;
-- Clears assumed destination defaults before creating objects.
-- Safe to load on a project that does not have those defaults.

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON FUNCTIONS FROM "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON FUNCTIONS FROM "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON FUNCTIONS FROM "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "service_role";
-- ===== public/sequences/inbox_id_seq.sql =====
CREATE SEQUENCE "public"."inbox_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;
-- ===== private/tables/member_signup_rate_limits.sql =====
CREATE TABLE "private"."member_signup_rate_limits" (
  "ip_hash"           text                     NOT NULL,
  "window_started_at" timestamp with time zone NOT NULL,
  "attempt_count"     integer                  NOT NULL,
  CONSTRAINT "member_signup_rate_limits_attempt_count_check" CHECK ((attempt_count >= 1)),
  CONSTRAINT "member_signup_rate_limits_ip_hash_check" CHECK ((ip_hash ~ '^[0-9a-f]{64}$'::text)),
  CONSTRAINT "member_signup_rate_limits_pkey" PRIMARY KEY (ip_hash)
);
ALTER TABLE "private"."member_signup_rate_limits"
  ENABLE ROW LEVEL SECURITY;
-- ===== private/tables/profile_church_link_authorizations.sql =====
CREATE TABLE "private"."profile_church_link_authorizations" (
  "backend_pid"       integer NOT NULL,
  "transaction_id"    bigint  NOT NULL,
  "actor_id"          uuid    NOT NULL,
  "target_profile_id" uuid    NOT NULL,
  "church_id"         uuid    NOT NULL,
  CONSTRAINT "profile_church_link_authorizations_pkey" PRIMARY KEY (backend_pid, transaction_id, actor_id, target_profile_id)
);
ALTER TABLE "private"."profile_church_link_authorizations"
  ENABLE ROW LEVEL SECURITY;
-- ===== private/tables/profile_role_authorizations.sql =====
CREATE TABLE "private"."profile_role_authorizations" (
  "backend_pid"       integer NOT NULL,
  "transaction_id"    bigint  NOT NULL,
  "actor_id"          uuid    NOT NULL,
  "target_profile_id" uuid    NOT NULL,
  "new_role"          text    NOT NULL,
  CONSTRAINT "profile_role_authorizations_pkey" PRIMARY KEY (backend_pid, transaction_id, actor_id, target_profile_id)
);
ALTER TABLE "private"."profile_role_authorizations"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/announcements.sql =====
CREATE TABLE "public"."announcements" (
  "id"          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "title"       text                     NOT NULL,
  "content"     text                     NOT NULL,
  "is_pinned"   boolean                  DEFAULT false,
  "created_at"  timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  "church_id"   uuid,
  "pinned"      boolean                  DEFAULT false,
  "sender_id"   uuid,
  "target_id"   uuid,
  "target_type" text                     DEFAULT 'all'::text,
  CONSTRAINT "announcements_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."announcements"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/blocks.sql =====
CREATE TABLE "public"."blocks" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "blocker_id" uuid                     NOT NULL,
  "blocked_id" uuid                     NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT "blocks_pkey" PRIMARY KEY (id),
  CONSTRAINT "prevent_self_block" CHECK ((blocker_id <> blocked_id)),
  CONSTRAINT "unique_block_pair" UNIQUE (blocker_id, blocked_id)
);
ALTER TABLE "public"."blocks"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/business_directory.sql =====
CREATE TABLE "public"."business_directory" (
  "id"            uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "church_id"     uuid                     NOT NULL,
  "user_id"       uuid                     NOT NULL,
  "business_name" text                     NOT NULL,
  "category"      text                     NOT NULL,
  "description"   text,
  "phone"         text,
  "email"         text,
  "website_url"   text,
  "is_approved"   boolean                  DEFAULT false,
  "created_at"    timestamp with time zone DEFAULT now(),
  "status"        text                     DEFAULT 'pending'::text,
  "updated_at"    timestamp with time zone DEFAULT now(),
  CONSTRAINT "business_directory_pkey" PRIMARY KEY (id),
  CONSTRAINT "business_directory_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE "public"."business_directory"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/business_proposals.sql =====
CREATE TABLE "public"."business_proposals" (
  "id"          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"     uuid,
  "title"       text,
  "description" text,
  "contact"     text,
  "phone"       text,
  "status"      text                     DEFAULT 'pending'::text,
  "created_at"  timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT "business_proposals_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."business_proposals"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/chat_messages.sql =====
CREATE TABLE "public"."chat_messages" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    uuid,
  "user_name"  text                     NOT NULL,
  "church_id"  text                     NOT NULL,
  "message"    text                     NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT "chat_messages_pkey" PRIMARY KEY (id),
  CONSTRAINT "chat_messages_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE "public"."chat_messages"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/church_invoices.sql =====
CREATE TABLE "public"."church_invoices" (
  "id"                        uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "church_id"                 uuid                     NOT NULL,
  "subscription_id"           uuid                     NOT NULL,
  "invoice_number"            text                     NOT NULL,
  "currency"                  text                     NOT NULL DEFAULT 'UGX'::text,
  "billing_period_start"      timestamp with time zone NOT NULL,
  "billing_period_end"        timestamp with time zone NOT NULL,
  "member_count"              integer                  NOT NULL,
  "included_members"          integer                  NOT NULL,
  "additional_members"        integer                  NOT NULL,
  "base_fee"                  bigint                   NOT NULL,
  "additional_member_fee"     bigint                   NOT NULL,
  "additional_members_amount" bigint                   NOT NULL,
  "total_amount"              bigint                   NOT NULL,
  "status"                    text                     NOT NULL DEFAULT 'draft'::text,
  "issued_at"                 timestamp with time zone,
  "due_at"                    timestamp with time zone,
  "paid_at"                   timestamp with time zone,
  "created_at"                timestamp with time zone NOT NULL DEFAULT now(),
  "billing_interval"          text                     NOT NULL,
  "subtotal_amount"           bigint                   NOT NULL,
  "discount_percentage"       numeric(5,2)             NOT NULL,
  "discount_amount"           bigint                   NOT NULL,
  CONSTRAINT "church_invoice_due_date_check" CHECK (((due_at IS NULL) OR (issued_at IS NULL) OR (due_at >= issued_at))),
  CONSTRAINT "church_invoice_period_check" CHECK ((billing_period_end > billing_period_start)),
  CONSTRAINT "church_invoice_period_unique" UNIQUE (church_id, billing_period_start, billing_period_end),
  CONSTRAINT "church_invoice_pricing_calculation_check"
    CHECK
    (((additional_members = GREATEST((member_count - included_members), 0)) AND (additional_members_amount = (additional_members * additional_member_fee)) AND (subtotal_amount =
    (base_fee + additional_members_amount)) AND (discount_amount = (round((((subtotal_amount)::numeric * discount_percentage) / 100.0)))::bigint) AND
    (total_amount = (subtotal_amount - discount_amount)))),
  CONSTRAINT "church_invoices_additional_member_fee_check" CHECK ((additional_member_fee >= 0)),
  CONSTRAINT "church_invoices_additional_members_amount_check" CHECK ((additional_members_amount >= 0)),
  CONSTRAINT "church_invoices_additional_members_check" CHECK ((additional_members >= 0)),
  CONSTRAINT "church_invoices_base_fee_check" CHECK ((base_fee >= 0)),
  CONSTRAINT "church_invoices_billing_interval_check" CHECK ((billing_interval = ANY (ARRAY['monthly'::text, 'annual'::text]))),
  CONSTRAINT "church_invoices_currency_check" CHECK ((currency = 'UGX'::text)),
  CONSTRAINT "church_invoices_discount_amount_check" CHECK ((discount_amount >= 0)),
  CONSTRAINT "church_invoices_discount_percentage_check"
    CHECK ((((billing_interval = 'monthly'::text) AND (discount_percentage = (0)::numeric)) OR ((billing_interval = 'annual'::text) AND (discount_percentage = (20)::numeric)))),
  CONSTRAINT "church_invoices_included_members_check" CHECK ((included_members >= 0)),
  CONSTRAINT "church_invoices_invoice_number_key" UNIQUE (invoice_number),
  CONSTRAINT "church_invoices_member_count_check" CHECK ((member_count >= 0)),
  CONSTRAINT "church_invoices_pkey" PRIMARY KEY (id),
  CONSTRAINT "church_invoices_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'issued'::text, 'paid'::text, 'overdue'::text, 'void'::text]))),
  CONSTRAINT "church_invoices_subtotal_amount_check" CHECK ((subtotal_amount >= 0)),
  CONSTRAINT "church_invoices_total_amount_check" CHECK ((total_amount >= 0))
);
ALTER TABLE "public"."church_invoices"
  ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_church_invoices_church ON public.church_invoices USING btree (church_id, created_at DESC);
CREATE INDEX idx_church_invoices_due ON public.church_invoices USING btree (status, due_at);
-- ===== public/tables/church_join_requests.sql =====
CREATE TABLE "public"."church_join_requests" (
  "id"             uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "full_name"      text,
  "phone"          text,
  "email"          text,
  "user_email"     text,
  "church_id"      uuid,
  "status"         text                     DEFAULT 'pending'::text,
  "created_at"     timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  "church_name"    text,
  "prayer_request" text,
  CONSTRAINT "church_join_requests_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."church_join_requests"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/church_leaders.sql =====
CREATE TABLE "public"."church_leaders" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "church_id"  uuid                     NOT NULL,
  "name"       text                     NOT NULL,
  "role"       text                     NOT NULL,
  "bio"        text,
  "image_url"  text,
  "created_at" timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT "church_leaders_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."church_leaders"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/church_payments.sql =====
CREATE TABLE "public"."church_payments" (
  "id"                      uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "church_id"               uuid                     NOT NULL,
  "invoice_id"              uuid                     NOT NULL,
  "provider"                text                     NOT NULL DEFAULT 'pesapal'::text,
  "provider_order_id"       text,
  "provider_transaction_id" text,
  "amount"                  bigint                   NOT NULL,
  "currency"                text                     NOT NULL DEFAULT 'UGX'::text,
  "status"                  text                     NOT NULL DEFAULT 'pending'::text,
  "payment_method"          text,
  "provider_status"         text,
  "verified_at"             timestamp with time zone,
  "created_at"              timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"              timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "church_payments_amount_check" CHECK ((amount > 0)),
  CONSTRAINT "church_payments_currency_check" CHECK ((currency = 'UGX'::text)),
  CONSTRAINT "church_payments_invoice_id_fkey" FOREIGN KEY (invoice_id) REFERENCES public.church_invoices(id) ON DELETE RESTRICT,
  CONSTRAINT "church_payments_pkey" PRIMARY KEY (id),
  CONSTRAINT "church_payments_provider_check" CHECK ((provider = 'pesapal'::text)),
  CONSTRAINT "church_payments_provider_order_id_key" UNIQUE (provider_order_id),
  CONSTRAINT "church_payments_provider_transaction_id_key" UNIQUE (provider_transaction_id),
  CONSTRAINT "church_payments_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'refunded'::text])))
);
ALTER TABLE "public"."church_payments"
  ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_church_payments_invoice ON public.church_payments USING btree (invoice_id);
CREATE INDEX idx_church_payments_status ON public.church_payments USING btree (status);
-- ===== public/tables/church_profiles.sql =====
CREATE TABLE "public"."church_profiles" (
  "id"                   uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "name"                 text                     NOT NULL,
  "description"          text,
  "logo_url"             text,
  "banner_url"           text,
  "pesapal_payment_link" text,
  "bank_name"            text,
  "account_name"         text,
  "account_number"       text,
  "momo_provider"        text,
  "momo_number"          text,
  "momo_registered_name" text,
  "created_at"           timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT "church_profiles_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."church_profiles"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/church_subscriptions.sql =====
CREATE TABLE "public"."church_subscriptions" (
  "id"                    uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "church_id"             uuid                     NOT NULL,
  "plan_name"             text                     NOT NULL DEFAULT 'standard'::text,
  "currency"              text                     NOT NULL DEFAULT 'UGX'::text,
  "base_fee"              bigint                   NOT NULL DEFAULT 30000,
  "included_members"      integer                  NOT NULL DEFAULT 100,
  "additional_member_fee" bigint                   NOT NULL DEFAULT 150,
  "billing_interval"      text                     NOT NULL DEFAULT 'monthly'::text,
  "status"                text                     NOT NULL DEFAULT 'trial'::text,
  "trial_starts_at"       timestamp with time zone,
  "trial_ends_at"         timestamp with time zone,
  "current_period_start"  timestamp with time zone,
  "current_period_end"    timestamp with time zone,
  "next_invoice_at"       timestamp with time zone,
  "grace_period_days"     integer                  NOT NULL DEFAULT 7,
  "is_internal_test"      boolean                  NOT NULL DEFAULT false,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "church_subscription_period_dates_check" CHECK (((current_period_start IS NULL) OR (current_period_end IS NULL) OR (current_period_end > current_period_start))),
  CONSTRAINT "church_subscription_trial_dates_check" CHECK (((trial_starts_at IS NULL) OR (trial_ends_at IS NULL) OR (trial_ends_at > trial_starts_at))),
  CONSTRAINT "church_subscriptions_additional_member_fee_check" CHECK ((additional_member_fee >= 0)),
  CONSTRAINT "church_subscriptions_base_fee_check" CHECK ((base_fee >= 0)),
  CONSTRAINT "church_subscriptions_billing_interval_check" CHECK ((billing_interval = ANY (ARRAY['monthly'::text, 'annual'::text]))),
  CONSTRAINT "church_subscriptions_church_id_key" UNIQUE (church_id),
  CONSTRAINT "church_subscriptions_currency_check" CHECK ((currency = 'UGX'::text)),
  CONSTRAINT "church_subscriptions_grace_period_days_check" CHECK (((grace_period_days >= 0) AND (grace_period_days <= 30))),
  CONSTRAINT "church_subscriptions_included_members_check" CHECK ((included_members >= 0)),
  CONSTRAINT "church_subscriptions_pkey" PRIMARY KEY (id),
  CONSTRAINT "church_subscriptions_status_check"
    CHECK ((status = ANY (ARRAY['trial'::text, 'active'::text, 'past_due'::text, 'suspended'::text, 'cancelled'::text, 'exempt'::text])))
);
ALTER TABLE "public"."church_subscriptions"
  ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_church_subscriptions_status ON public.church_subscriptions USING btree (status);
-- ===== public/tables/churches.sql =====
CREATE TABLE "public"."churches" (
  "id"                      uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "name"                    text                     NOT NULL,
  "location"                text,
  "description"             text,
  "created_at"              timestamp with time zone DEFAULT timezone('utc'::text, now()),
  "latitude"                numeric(9,6),
  "longitude"               numeric(9,6),
  "join_code"               text,
  "address"                 text,
  "logo_url"                text,
  "code"                    text,
  "trial_ends_at"           timestamp with time zone DEFAULT (now() + '6 mons'::interval),
  "subscription_status"     text                     DEFAULT 'trial'::text,
  "pesapal_consumer_key"    text,
  "pesapal_consumer_secret" text,
  "pesapal_ipn_id"          text,
  "pesapal_env"             character varying(10)    DEFAULT 'sandbox'::character varying,
  "live_stream_id"          text,
  "is_live"                 boolean                  DEFAULT false,
  "status"                  text                     DEFAULT 'pending'::text,
  "admin_feedback"          text,
  "applicant_user_id"       uuid,
  CONSTRAINT "churches_code_key" UNIQUE (code),
  CONSTRAINT "churches_join_code_key" UNIQUE (join_code),
  CONSTRAINT "churches_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."churches"
  ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_churches_join_code ON public.churches USING btree (join_code);
-- ===== public/tables/comments.sql =====
CREATE TABLE "public"."comments" (
  "id"         bigint                      GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "content"    text,
  "created_at" timestamp without time zone DEFAULT now(),
  "post_id"    uuid,
  CONSTRAINT "comments_pkey" PRIMARY KEY (id),
  "user_id"    uuid                        DEFAULT auth.uid()
);
ALTER TABLE "public"."comments"
  ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE "public"."comments" IS 'Updating schema';
-- ===== public/tables/community_needs.sql =====
CREATE TABLE "public"."community_needs" (
  "id"           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"      uuid                     NOT NULL,
  "category"     text                     NOT NULL,
  "title"        text                     NOT NULL,
  "description"  text                     NOT NULL,
  "contact_info" text,
  "status"       text                     DEFAULT 'open'::text,
  "created_at"   timestamp with time zone DEFAULT now(),
  "church_id"    uuid,
  CONSTRAINT "community_needs_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."community_needs"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/connections.sql =====
CREATE TABLE "public"."connections" (
  "id"           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "requester_id" uuid,
  "recipient_id" uuid,
  "status"       text                     DEFAULT 'pending'::text,
  "created_at"   timestamp with time zone DEFAULT timezone('utc'::text, now()),
  "updated_at"   timestamp with time zone DEFAULT now(),
  CONSTRAINT "connections_pkey" PRIMARY KEY (id),
  CONSTRAINT "connections_requester_id_recipient_id_key" UNIQUE (requester_id, recipient_id),
  CONSTRAINT "connections_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text])))
);
ALTER TABLE "public"."connections"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/conversion_requests.sql =====
CREATE TABLE "public"."conversion_requests" (
  "id"                uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "full_name"         text                     NOT NULL,
  "phone_number"      text                     NOT NULL,
  "email"             text,
  "prayer_request"    text,
  "status"            text                     DEFAULT 'Pending'::text,
  "created_at"        timestamp with time zone DEFAULT timezone('utc'::text, now()),
  "church_id"         uuid,
  "category"          text,
  "contact_method"    text,
  "contact_detail"    text,
  "consent_given"     boolean                  NOT NULL DEFAULT false,
  "consent_timestamp" timestamp with time zone,
  CONSTRAINT "conversion_requests_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."conversion_requests"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/counseling_appointments.sql =====
CREATE TABLE "public"."counseling_appointments" (
  "id"               uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"          uuid                     NOT NULL,
  "member_name"      text                     NOT NULL,
  "member_email"     text,
  "appointment_date" date                     NOT NULL,
  "appointment_time" time without time zone   NOT NULL,
  "reason"           text,
  "status"           text                     DEFAULT 'Pending'::text,
  "created_at"       timestamp with time zone DEFAULT now(),
  CONSTRAINT "counseling_appointments_pkey" PRIMARY KEY (id),
  CONSTRAINT "counseling_appointments_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
ALTER TABLE "public"."counseling_appointments"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/donations.sql =====
CREATE TABLE "public"."donations" (
  "id"                    uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"               uuid,
  "amount"                numeric(10,2)            NOT NULL,
  "currency"              text                     DEFAULT 'UGX'::text,
  "status"                text                     DEFAULT 'pending'::text,
  "transaction_reference" text,
  "created_at"            timestamp with time zone DEFAULT now(),
  "is_recurring"          boolean                  DEFAULT false,
  "payment_gateway"       text                     DEFAULT 'pesapal'::text,
  "pesapal_tracking_id"   text,
  CONSTRAINT "donations_pesapal_tracking_id_key" UNIQUE (pesapal_tracking_id),
  CONSTRAINT "donations_pkey" PRIMARY KEY (id),
  CONSTRAINT "donations_transaction_reference_key" UNIQUE (transaction_reference),
  CONSTRAINT "donations_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
ALTER TABLE "public"."donations"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/event_attendees.sql =====
CREATE TABLE "public"."event_attendees" (
  "id"         uuid                     NOT NULL DEFAULT extensions.uuid_generate_v4(),
  "event_id"   uuid,
  "user_id"    uuid,
  "user_email" text                     NOT NULL,
  "status"     character varying(20)    DEFAULT 'registered'::character varying,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "event_attendees_event_id_user_id_key" UNIQUE (event_id, user_id),
  CONSTRAINT "event_attendees_pkey" PRIMARY KEY (id),
  CONSTRAINT "event_attendees_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE "public"."event_attendees"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/event_invitations.sql =====
CREATE TABLE "public"."event_invitations" (
  "id"        uuid NOT NULL DEFAULT gen_random_uuid(),
  "event_id"  uuid,
  "member_id" uuid,
  "status"    text DEFAULT 'invited'::text,
  CONSTRAINT "event_invitations_event_id_member_id_key" UNIQUE (event_id, member_id),
  CONSTRAINT "event_invitations_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."event_invitations"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/event_registrations.sql =====
CREATE TABLE "public"."event_registrations" (
  "id"             uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "event_id"       uuid                     NOT NULL,
  "profile_id"     uuid                     NOT NULL,
  "registered_at"  timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  "amount_paid"    numeric                  DEFAULT 0.00,
  "coupon_number"  text,
  "is_free"        boolean                  DEFAULT false,
  "attendee_name"  text,
  "attendee_email" text,
  "photo_url"      text,
  "user_id"        uuid,
  CONSTRAINT "event_registrations_event_id_profile_id_key" UNIQUE (event_id, profile_id),
  CONSTRAINT "event_registrations_pkey" PRIMARY KEY (id),
  CONSTRAINT "event_registrations_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
ALTER TABLE "public"."event_registrations"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/event_rsvps.sql =====
CREATE TABLE "public"."event_rsvps" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "event_id"   uuid                     NOT NULL,
  "user_id"    uuid                     NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT "event_rsvps_pkey" PRIMARY KEY (id),
  CONSTRAINT "unique_user_event_rsvp" UNIQUE (user_id, event_id)
);
ALTER TABLE "public"."event_rsvps"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/events.sql =====
CREATE TABLE "public"."events" (
  "id"                 uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "title"              text                     NOT NULL,
  "description"        text,
  "event_date"         timestamp with time zone NOT NULL,
  "location"           text,
  "created_at"         timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  "church_id"          uuid,
  "bible_link"         text,
  "created_by"         uuid,
  "category"           text,
  "image_url"          text,
  "host_church_id"     uuid,
  "invited_church_ids" uuid[]                   DEFAULT '{}'::uuid[],
  "coupon_color"       text                     DEFAULT '#2563eb'::text,
  CONSTRAINT "events_church_id_fkey" FOREIGN KEY (church_id) REFERENCES public.churches(id),
  CONSTRAINT "events_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT "events_host_church_id_fkey" FOREIGN KEY (host_church_id) REFERENCES public.churches(id),
  CONSTRAINT "events_pkey" PRIMARY KEY (id),
  "user_id"            uuid                     DEFAULT auth.uid()
);
ALTER TABLE "public"."events"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/gallery_images.sql =====
CREATE TABLE "public"."gallery_images" (
  "id"            uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "created_at"    timestamp with time zone DEFAULT now(),
  "image_url"     text                     NOT NULL,
  "caption"       text,
  "church_id"     uuid,
  "uploaded_by"   uuid,
  "uploader_name" text,
  CONSTRAINT "gallery_images_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."gallery_images"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/giving_settings.sql =====
CREATE TABLE "public"."giving_settings" (
  "id"                  integer                  NOT NULL DEFAULT 1,
  "bank_name"           text,
  "account_name"        text,
  "account_number"      text,
  "mobile_money_name"   text,
  "mobile_money_number" text,
  "airtel_name"         text,
  "airtel_number"       text,
  "mtn_name"            text,
  "mtn_number"          text,
  "branch"              text,
  "momo_name"           text,
  "momo_number"         text,
  "updated_at"          timestamp with time zone DEFAULT timezone('utc'::text, now()),
  CONSTRAINT "giving_settings_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."giving_settings"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/group_members.sql =====
CREATE TABLE "public"."group_members" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "group_id"   uuid                     NOT NULL,
  "user_id"    uuid                     NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "group_members_group_id_user_id_key" UNIQUE (group_id, user_id),
  CONSTRAINT "group_members_pkey" PRIMARY KEY (id),
  CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE "public"."group_members"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/groups.sql =====
CREATE TABLE "public"."groups" (
  "id"                 uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "church_id"          uuid                     NOT NULL,
  "name"               text                     NOT NULL,
  "location"           text,
  "meeting_time"       text,
  "leader_name"        text,
  "created_at"         timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  "allow_instant_join" boolean                  NOT NULL DEFAULT true,
  "description"        text,
  "category"           text,
  CONSTRAINT "groups_church_id_fkey" FOREIGN KEY (church_id) REFERENCES public.churches(id) ON DELETE CASCADE,
  CONSTRAINT "groups_pkey" PRIMARY KEY (id),
  "created_by"         uuid                     DEFAULT auth.uid(),
  CONSTRAINT "groups_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id)
);
ALTER TABLE "public"."groups"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/important_documents.sql =====
CREATE TABLE "public"."important_documents" (
  "id"          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "title"       text                     NOT NULL,
  "description" text,
  "file_url"    text                     NOT NULL,
  "uploaded_by" uuid,
  "created_at"  timestamp with time zone DEFAULT now(),
  CONSTRAINT "important_documents_pkey" PRIMARY KEY (id),
  CONSTRAINT "important_documents_uploaded_by_fkey" FOREIGN KEY (uploaded_by) REFERENCES auth.users(id)
);
ALTER TABLE "public"."important_documents"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/inbox.sql =====
CREATE TABLE "public"."inbox" (
  "id"          bigint                   NOT NULL DEFAULT nextval('public.inbox_id_seq'::regclass),
  "sender_name" text,
  "message"     text                     NOT NULL,
  "church_id"   text,
  "created_at"  timestamp with time zone DEFAULT now(),
  CONSTRAINT "inbox_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."inbox"
  ENABLE ROW LEVEL SECURITY;
ALTER SEQUENCE "public"."inbox_id_seq" OWNED BY "public"."inbox"."id";
-- ===== public/tables/join_church_requests.sql =====
CREATE TABLE "public"."join_church_requests" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "full_name"  text,
  "email"      text,
  "phone"      text,
  "address"    text,
  "notes"      text,
  "created_at" timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT "join_church_requests_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."join_church_requests"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/join_requests.sql =====
CREATE TABLE "public"."join_requests" (
  "id"           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "church_id"    uuid                     NOT NULL,
  "name"         text                     NOT NULL,
  "contact_info" text,
  "details"      text,
  "status"       text                     NOT NULL DEFAULT 'pending'::text,
  "created_at"   timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT "join_requests_church_id_fkey" FOREIGN KEY (church_id) REFERENCES public.church_profiles(id) ON DELETE CASCADE,
  CONSTRAINT "join_requests_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."join_requests"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/likes.sql =====
CREATE TABLE "public"."likes" (
  "id"         bigint                   GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "user_id"    uuid                     NOT NULL,
  "post_id"    uuid                     NOT NULL,
  "created_at" timestamp with time zone DEFAULT timezone('utc'::text, now()),
  CONSTRAINT "likes_pkey" PRIMARY KEY (id),
  CONSTRAINT "likes_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT "likes_user_id_post_id_key" UNIQUE (user_id, post_id)
);
ALTER TABLE "public"."likes"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/messages.sql =====
CREATE TABLE "public"."messages" (
  "id"           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "sender_id"    uuid,
  "receiver_id"  uuid,
  "content"      text                     NOT NULL,
  "created_at"   timestamp with time zone DEFAULT timezone('utc'::text, now()),
  "is_read"      boolean                  DEFAULT false,
  "recipient_id" uuid,
  "group_id"     uuid,
  "department"   text                     DEFAULT 'general'::text,
  CONSTRAINT "messages_group_id_fkey" FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE,
  CONSTRAINT "messages_pkey" PRIMARY KEY (id),
  CONSTRAINT "messages_recipient_id_fkey" FOREIGN KEY (recipient_id) REFERENCES auth.users(id)
);
ALTER TABLE "public"."messages"
  ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_messages_group_id ON public.messages USING btree (group_id);
-- ===== public/tables/ministry_requests.sql =====
CREATE TABLE "public"."ministry_requests" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "full_name"  text,
  "phone"      text,
  "request"    text,
  "user_email" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT "ministry_requests_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."ministry_requests"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/music_tracks.sql =====
CREATE TABLE "public"."music_tracks" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "title"      text                     NOT NULL,
  "artist"     text                     DEFAULT 'Unknown Artist'::text,
  "audio_url"  text                     NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "music_tracks_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."music_tracks"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/notifications.sql =====
CREATE TABLE "public"."notifications" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    uuid,
  "title"      text                     NOT NULL,
  "message"    text                     NOT NULL,
  "is_read"    boolean                  DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now(),
  "type"       text                     DEFAULT 'message'::text,
  "content"    text,
  "actor_id"   uuid,
  "church_id"  uuid,
  "link"       text,
  CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT "notifications_pkey" PRIMARY KEY (id),
  CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
ALTER TABLE "public"."notifications"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/post_reactions.sql =====
CREATE TABLE "public"."post_reactions" (
  "id"            uuid NOT NULL DEFAULT gen_random_uuid(),
  "post_id"       uuid,
  "user_id"       uuid,
  "reaction_type" text NOT NULL,
  CONSTRAINT "post_reactions_pkey" PRIMARY KEY (id),
  CONSTRAINT "post_reactions_post_id_user_id_reaction_type_key" UNIQUE (post_id, user_id, reaction_type),
  CONSTRAINT "post_reactions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE "public"."post_reactions"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/posts.sql =====
CREATE TABLE "public"."posts" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    uuid                     NOT NULL,
  "content"    text                     NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "is_pinned"  boolean                  DEFAULT false,
  "bible_link" text,
  "amen_count" integer                  DEFAULT 0,
  "category"   text                     DEFAULT 'Encouragement'::text,
  "church_id"  text,
  CONSTRAINT "posts_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."posts"
  ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE "public"."posts" IS 'trigger schema refresh';
-- ===== public/tables/prayer_requests.sql =====
CREATE TABLE "public"."prayer_requests" (
  "id"             uuid                     NOT NULL DEFAULT extensions.uuid_generate_v4(),
  "user_id"        uuid,
  "church_id"      uuid,
  "content"        text,
  "created_at"     timestamp with time zone DEFAULT timezone('utc'::text, now()),
  "prayers_count"  integer                  DEFAULT 0,
  "is_private"     boolean                  DEFAULT false,
  "is_testimony"   boolean                  DEFAULT true,
  "title"          text,
  "contact_info"   text,
  "full_name"      text,
  "name"           text,
  "email"          text,
  "phone"          text,
  "request_text"   text,
  "message"        text,
  "status"         text                     DEFAULT 'pending'::text,
  "prayer_request" text,
  "details"        text,
  "prayer"         text,
  "description"    text,
  "phone_number"   text,
  "contact"        text,
  CONSTRAINT "prayer_requests_church_id_fkey" FOREIGN KEY (church_id) REFERENCES public.churches(id),
  CONSTRAINT "prayer_requests_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."prayer_requests"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/prayer_responses.sql =====
CREATE TABLE "public"."prayer_responses" (
  "id"                uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "prayer_request_id" uuid                     NOT NULL,
  "user_id"           uuid                     NOT NULL,
  "response_text"     text                     NOT NULL,
  "created_at"        timestamp with time zone DEFAULT now(),
  "parent_id"         uuid,
  CONSTRAINT "prayer_responses_pkey" PRIMARY KEY (id),
  CONSTRAINT "prayer_responses_parent_id_fkey" FOREIGN KEY (parent_id) REFERENCES public.prayer_responses(id) ON DELETE CASCADE,
  CONSTRAINT "prayer_responses_prayer_request_id_fkey" FOREIGN KEY (prayer_request_id) REFERENCES public.prayer_requests(id) ON DELETE CASCADE
);
ALTER TABLE "public"."prayer_responses"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/prayer_supports.sql =====
CREATE TABLE "public"."prayer_supports" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "request_id" uuid,
  "user_id"    uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "prayer_supports_pkey" PRIMARY KEY (id),
  CONSTRAINT "prayer_supports_request_id_fkey" FOREIGN KEY (request_id) REFERENCES public.prayer_requests(id) ON DELETE CASCADE,
  CONSTRAINT "prayer_supports_request_id_user_id_key" UNIQUE (request_id, user_id),
  CONSTRAINT "prayer_supports_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE "public"."prayer_supports"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/prayers.sql =====
CREATE TABLE "public"."prayers" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "request_id" uuid,
  "user_id"    uuid,
  "created_at" timestamp with time zone DEFAULT timezone('utc'::text, now()),
  CONSTRAINT "prayers_pkey" PRIMARY KEY (id),
  CONSTRAINT "prayers_request_id_fkey" FOREIGN KEY (request_id) REFERENCES public.prayer_requests(id) ON DELETE CASCADE,
  CONSTRAINT "prayers_request_id_user_id_key" UNIQUE (request_id, user_id)
);
ALTER TABLE "public"."prayers"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/profiles.sql =====
CREATE TABLE "public"."profiles" (
  "id"                   uuid                     NOT NULL,
  "username"             text,
  "bio"                  text,
  "created_at"           timestamp with time zone DEFAULT now(),
  "full_name"            text,
  "church"               text,
  "avatar_url"           text,
  "church_id"            uuid,
  "role"                 text                     DEFAULT 'member'::text,
  "is_admin"             boolean                  DEFAULT false,
  "home_cell"            text,
  "favorite_scripture"   text,
  "email"                text,
  "verification_type"    character varying(50)    DEFAULT 'none'::character varying,
  "is_verified"          boolean                  DEFAULT false,
  "position"             text,
  "display_name"         text,
  "is_blocked"           boolean                  DEFAULT false,
  "status"               text                     DEFAULT 'active'::text,
  "sunday_service_time"  text,
  "midweek_service_time" text,
  "physical_address"     text,
  "map_embed_url"        text,
  "is_approved"          boolean                  DEFAULT true,
  "phone"                text,
  CONSTRAINT "profiles_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT "profiles_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."profiles"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/programmes.sql =====
CREATE TABLE "public"."programmes" (
  "id"             uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "church_id"      uuid,
  "title"          text                     NOT NULL,
  "programme_date" timestamp with time zone,
  "description"    text,
  "start_time"     time without time zone,
  "bible_link"     text,
  "created_at"     timestamp with time zone DEFAULT now(),
  "day_of_week"    text                     DEFAULT 'Every Sunday'::text,
  "end_time"       text,
  "schedule_text"  text,
  "location"       text,
  "venue"          text,
  CONSTRAINT "programmes_church_id_fkey" FOREIGN KEY (church_id) REFERENCES public.churches(id) ON DELETE CASCADE,
  CONSTRAINT "programmes_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."programmes"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/public_church_requests.sql =====
CREATE TABLE "public"."public_church_requests" (
  "id"           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "full_name"    text,
  "name"         text,
  "phone"        text,
  "phone_number" text,
  "email"        text,
  "church_name"  text,
  "status"       text                     DEFAULT 'pending'::text,
  "created_at"   timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT "public_church_requests_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."public_church_requests"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/role_audit_log.sql =====
CREATE TABLE "public"."role_audit_log" (
  "id"                bigint                   GENERATED ALWAYS AS IDENTITY NOT NULL,
  "actor_id"          uuid,
  "target_profile_id" uuid                     NOT NULL,
  "church_id"         uuid,
  "old_role"          text,
  "new_role"          text,
  "action"            text                     NOT NULL DEFAULT 'role_change'::text,
  "changed_at"        timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "role_audit_log_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."role_audit_log"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/rsvps.sql =====
CREATE TABLE "public"."rsvps" (
  "id"           uuid NOT NULL DEFAULT gen_random_uuid(),
  "programme_id" uuid,
  "user_id"      uuid,
  "status"       text DEFAULT 'attending'::text,
  CONSTRAINT "rsvps_pkey" PRIMARY KEY (id),
  CONSTRAINT "rsvps_programme_id_fkey" FOREIGN KEY (programme_id) REFERENCES public.programmes(id),
  CONSTRAINT "rsvps_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE
);
ALTER TABLE "public"."rsvps"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/sermon_notes.sql =====
CREATE TABLE "public"."sermon_notes" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    uuid                     NOT NULL,
  "sermon_id"  uuid,
  "note_text"  text                     NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "sermon_notes_pkey" PRIMARY KEY (id),
  CONSTRAINT "sermon_notes_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE "public"."sermon_notes"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/sermons.sql =====
CREATE TABLE "public"."sermons" (
  "id"            uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "title"         text                     NOT NULL,
  "preacher"      text                     NOT NULL,
  "audio_url"     text,
  "church_id"     uuid,
  "created_at"    timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  "church_name"   text,
  "category"      text,
  "media_type"    text,
  "media_url"     text,
  "video_url"     text,
  "thumbnail_url" text,
  "description"   text,
  CONSTRAINT "sermons_church_id_fkey" FOREIGN KEY (church_id) REFERENCES public.churches(id) ON DELETE CASCADE,
  CONSTRAINT "sermons_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."sermons"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/subscription_events.sql =====
CREATE TABLE "public"."subscription_events" (
  "id"              uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "church_id"       uuid                     NOT NULL,
  "subscription_id" uuid,
  "invoice_id"      uuid,
  "event_type"      text                     NOT NULL,
  "description"     text,
  "actor_user_id"   uuid,
  "metadata"        jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "subscription_events_actor_user_id_fkey" FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT "subscription_events_church_id_fkey" FOREIGN KEY (church_id) REFERENCES public.churches(id) ON DELETE RESTRICT,
  CONSTRAINT "subscription_events_invoice_id_fkey" FOREIGN KEY (invoice_id) REFERENCES public.church_invoices(id) ON DELETE RESTRICT,
  CONSTRAINT "subscription_events_pkey" PRIMARY KEY (id),
  CONSTRAINT "subscription_events_subscription_id_fkey" FOREIGN KEY (subscription_id) REFERENCES public.church_subscriptions(id) ON DELETE RESTRICT
);
ALTER TABLE "public"."subscription_events"
  ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_subscription_events_church ON public.subscription_events USING btree (church_id, created_at DESC);
-- ===== public/tables/testimonies.sql =====
CREATE TABLE "public"."testimonies" (
  "id"          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"     uuid,
  "author_name" text                     NOT NULL,
  "title"       text                     NOT NULL,
  "content"     text                     NOT NULL,
  "created_at"  timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  "is_private"  boolean                  DEFAULT false,
  CONSTRAINT "fk_testimonies_profiles" FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT "testimonies_pkey" PRIMARY KEY (id),
  CONSTRAINT "testimonies_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE "public"."testimonies"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/testimony_replies.sql =====
CREATE TABLE "public"."testimony_replies" (
  "id"           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "testimony_id" uuid,
  "user_id"      uuid,
  "content"      text                     NOT NULL,
  "created_at"   timestamp with time zone DEFAULT timezone('utc'::text, now()),
  CONSTRAINT "testimony_replies_pkey" PRIMARY KEY (id),
  CONSTRAINT "testimony_replies_testimony_id_fkey" FOREIGN KEY (testimony_id) REFERENCES public.testimonies(id) ON DELETE CASCADE,
  CONSTRAINT "testimony_replies_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE
);
ALTER TABLE "public"."testimony_replies"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/transactions.sql =====
CREATE TABLE "public"."transactions" (
  "id"                  uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"             uuid,
  "merchant_reference"  text                     NOT NULL,
  "pesapal_tracking_id" text,
  "amount"              numeric(12,2)            NOT NULL,
  "currency"            text                     DEFAULT 'UGX'::text,
  "payment_type"        text                     NOT NULL DEFAULT 'offering'::text,
  "payment_method"      text,
  "status"              text                     NOT NULL DEFAULT 'PENDING'::text,
  "payer_name"          text,
  "payer_email"         text,
  "payer_phone"         text,
  "description"         text,
  "created_at"          timestamp with time zone DEFAULT now(),
  "updated_at"          timestamp with time zone DEFAULT now(),
  "church_id"           uuid                     NOT NULL,
  "payer_country"       text,
  CONSTRAINT "transactions_amount_check" CHECK ((amount > (0)::numeric)),
  CONSTRAINT "transactions_church_id_fkey" FOREIGN KEY (church_id) REFERENCES public.churches(id) ON DELETE RESTRICT,
  CONSTRAINT "transactions_merchant_reference_key" UNIQUE (merchant_reference),
  CONSTRAINT "transactions_payer_country_format_check" CHECK (((payer_country IS NULL) OR (payer_country ~ '^[A-Z]{2}$'::text))),
  CONSTRAINT "transactions_pkey" PRIMARY KEY (id),
  CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL
);
ALTER TABLE "public"."transactions"
  ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_transactions_church_id_created_at ON public.transactions USING btree (church_id, created_at DESC);
CREATE INDEX idx_transactions_merchant_ref ON public.transactions USING btree (merchant_reference);
CREATE INDEX idx_transactions_pesapal_track_id ON public.transactions USING btree (pesapal_tracking_id);
CREATE INDEX idx_transactions_status ON public.transactions USING btree (status);
CREATE INDEX idx_transactions_user_id ON public.transactions USING btree (user_id);
-- ===== public/tables/user_reflections.sql =====
CREATE TABLE "public"."user_reflections" (
  "id"              uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "user_id"         uuid                     NOT NULL,
  "verse_reference" text                     NOT NULL,
  "verse_text"      text                     NOT NULL,
  "note"            text                     NOT NULL,
  "created_at"      timestamp with time zone DEFAULT now(),
  CONSTRAINT "user_reflections_pkey" PRIMARY KEY (id),
  CONSTRAINT "user_reflections_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE "public"."user_reflections"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/violations.sql =====
CREATE TABLE "public"."violations" (
  "id"               uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "event_id"         uuid,
  "reporter_id"      uuid,
  "reason"           text                     NOT NULL,
  "details"          text,
  "status"           text                     DEFAULT 'pending'::text,
  "created_at"       timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  "reported_user_id" uuid,
  "proof_url"        text,
  CONSTRAINT "violations_event_id_fkey" FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE,
  CONSTRAINT "violations_pkey" PRIMARY KEY (id),
  CONSTRAINT "violations_reported_user_id_fkey" FOREIGN KEY (reported_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT "violations_reporter_id_fkey" FOREIGN KEY (reporter_id) REFERENCES public.profiles(id) ON DELETE SET NULL
);
ALTER TABLE "public"."violations"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/volunteer_roster.sql =====
CREATE TABLE "public"."volunteer_roster" (
  "id"               uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "title"            text                     NOT NULL,
  "event_date"       date                     DEFAULT CURRENT_DATE,
  "description"      text,
  "assigned_user_id" uuid,
  "created_at"       timestamp with time zone DEFAULT now(),
  "event_id"         uuid,
  "church_id"        uuid,
  "max_capacity"     integer                  DEFAULT 5,
  "is_active"        boolean                  DEFAULT true,
  CONSTRAINT "fk_volunteer_roster_events" FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE,
  CONSTRAINT "volunteer_roster_assigned_user_id_fkey" FOREIGN KEY (assigned_user_id) REFERENCES auth.users(id),
  CONSTRAINT "volunteer_roster_church_id_fkey" FOREIGN KEY (church_id) REFERENCES public.churches(id) ON DELETE CASCADE,
  CONSTRAINT "volunteer_roster_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."volunteer_roster"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/volunteer_signups.sql =====
CREATE TABLE "public"."volunteer_signups" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "slot_id"    uuid,
  "user_id"    uuid,
  "full_name"  text,
  "email"      text,
  "phone"      text,
  "created_at" timestamp with time zone DEFAULT now(),
  "slot_title" text,
  "slot_name"  text,
  "user_email" text,
  CONSTRAINT "unique_user_slot" UNIQUE (user_id, slot_id),
  CONSTRAINT "volunteer_signups_pkey" PRIMARY KEY (id),
  CONSTRAINT "volunteer_signups_slot_id_fkey" FOREIGN KEY (slot_id) REFERENCES public.volunteer_roster(id) ON DELETE CASCADE,
  CONSTRAINT "volunteer_signups_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE "public"."volunteer_signups"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/worship_songs.sql =====
CREATE TABLE "public"."worship_songs" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "title"      text                     NOT NULL,
  "artist"     text                     DEFAULT 'Unknown Artist'::text,
  "audio_url"  text                     NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "church_id"  uuid,
  CONSTRAINT "worship_songs_pkey" PRIMARY KEY (id)
);
ALTER TABLE "public"."worship_songs"
  ENABLE ROW LEVEL SECURITY;
-- ===== public/tables/churches.fk.sql =====
-- Foreign keys in a cross-table reference cycle are split out of their
-- table's file: each file loads atomically, so keeping them inline would
-- deadlock the loader (every file would need a table another pending file
-- creates). These statements apply once all referenced tables exist.

ALTER TABLE "public"."churches"
  ADD CONSTRAINT "churches_applicant_user_id_fkey" FOREIGN KEY (applicant_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
-- ===== public/tables/profiles.fk.sql =====
-- Foreign keys in a cross-table reference cycle are split out of their
-- table's file: each file loads atomically, so keeping them inline would
-- deadlock the loader (every file would need a table another pending file
-- creates). These statements apply once all referenced tables exist.

ALTER TABLE "public"."profiles"
  ADD CONSTRAINT "profiles_church_id_fkey" FOREIGN KEY (church_id) REFERENCES public.churches(id);
-- ===== DEFERRED FORWARD FOREIGN KEYS =====
-- Original constraint definitions preserved.

ALTER TABLE "public"."announcements" ADD CONSTRAINT "announcements_church_id_fkey" FOREIGN KEY (church_id) REFERENCES public.churches(id);
ALTER TABLE "public"."announcements" ADD CONSTRAINT "announcements_sender_id_fkey" FOREIGN KEY (sender_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE "public"."blocks" ADD CONSTRAINT "blocks_blocked_id_fkey" FOREIGN KEY (blocked_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."blocks" ADD CONSTRAINT "blocks_blocker_id_fkey" FOREIGN KEY (blocker_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."church_invoices" ADD CONSTRAINT "church_invoices_subscription_id_fkey" FOREIGN KEY (subscription_id) REFERENCES public.church_subscriptions(id) ON DELETE RESTRICT;
ALTER TABLE "public"."church_invoices" ADD CONSTRAINT "church_invoices_church_id_fkey" FOREIGN KEY (church_id) REFERENCES public.churches(id) ON DELETE RESTRICT;
ALTER TABLE "public"."church_payments" ADD CONSTRAINT "church_payments_church_id_fkey" FOREIGN KEY (church_id) REFERENCES public.churches(id) ON DELETE RESTRICT;
ALTER TABLE "public"."church_subscriptions" ADD CONSTRAINT "church_subscriptions_church_id_fkey" FOREIGN KEY (church_id) REFERENCES public.churches(id) ON DELETE RESTRICT;
ALTER TABLE "public"."comments" ADD CONSTRAINT "fk_post_id" FOREIGN KEY (post_id) REFERENCES public.posts(id);
ALTER TABLE "public"."comments" ADD CONSTRAINT "fk_comments_user_id" FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."community_needs" ADD CONSTRAINT "community_needs_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."connections" ADD CONSTRAINT "connections_recipient_id_fkey" FOREIGN KEY (recipient_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."connections" ADD CONSTRAINT "connections_requester_id_fkey" FOREIGN KEY (requester_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."event_attendees" ADD CONSTRAINT "event_attendees_event_id_fkey" FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;
ALTER TABLE "public"."event_invitations" ADD CONSTRAINT "event_invitations_event_id_fkey" FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;
ALTER TABLE "public"."event_invitations" ADD CONSTRAINT "event_invitations_member_id_fkey" FOREIGN KEY (member_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."event_registrations" ADD CONSTRAINT "event_registrations_event_id_fkey" FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;
ALTER TABLE "public"."event_registrations" ADD CONSTRAINT "event_registrations_profile_id_fkey" FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."event_rsvps" ADD CONSTRAINT "event_rsvps_event_id_fkey" FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;
ALTER TABLE "public"."event_rsvps" ADD CONSTRAINT "event_rsvps_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."events" ADD CONSTRAINT "events_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;
ALTER TABLE "public"."group_members" ADD CONSTRAINT "fk_group_members_profile" FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."likes" ADD CONSTRAINT "likes_post_id_fkey" FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;
ALTER TABLE "public"."messages" ADD CONSTRAINT "messages_receiver_id_fkey" FOREIGN KEY (receiver_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY (sender_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."post_reactions" ADD CONSTRAINT "post_reactions_post_id_fkey" FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;
ALTER TABLE "public"."posts" ADD CONSTRAINT "posts_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."prayer_requests" ADD CONSTRAINT "prayer_requests_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."prayer_responses" ADD CONSTRAINT "prayer_responses_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."prayers" ADD CONSTRAINT "prayers_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE "public"."sermon_notes" ADD CONSTRAINT "sermon_notes_sermon_id_fkey" FOREIGN KEY (sermon_id) REFERENCES public.sermons(id) ON DELETE CASCADE;
-- ===== public/functions/is_super_admin.sql =====
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM private.platform_admins AS pa
        INNER JOIN public.profiles AS p
            ON p.id = pa.user_id
        WHERE pa.user_id = auth.uid()
          AND p.role = 'super_admin'
          AND p.status = 'active'
          AND COALESCE(p.is_blocked, false) = false
    );
$function$;
CREATE OR REPLACE FUNCTION public.is_super_admin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT
        p_user_id IS NOT NULL
        AND p_user_id = auth.uid()
        AND EXISTS (
            SELECT 1
            FROM private.platform_admins AS pa
            INNER JOIN public.profiles AS p
                ON p.id = pa.user_id
            WHERE pa.user_id = p_user_id
              AND p.role = 'super_admin'
              AND p.status = 'active'
              AND COALESCE(p.is_blocked, false) = false
        );
$function$;
-- ===== public/functions/approve_church_application.sql =====
CREATE OR REPLACE FUNCTION public.approve_church_application (
  p_church_id uuid
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
    v_status text;
    v_applicant_id uuid;
    v_applicant_church_id uuid;
    v_applicant_role text;
    v_applicant_status text;
    v_applicant_is_blocked boolean;
    v_trial_start timestamptz;
    v_trial_end timestamptz;
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Super Admin required.';
    END IF;

    SELECT c.status, c.applicant_user_id
      INTO v_status, v_applicant_id
      FROM public.churches AS c
     WHERE c.id = p_church_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Church registration request not found.';
    END IF;

    IF v_status IS NULL
       OR v_status NOT IN ('pending', 'changes requested') THEN
        RAISE EXCEPTION
            'This church registration is not awaiting review.';
    END IF;

    IF v_applicant_id IS NULL THEN
        RAISE EXCEPTION
            'This record has no registration applicant.';
    END IF;

    SELECT
        p.church_id,
        p.role,
        p.status,
        COALESCE(p.is_blocked, false)
      INTO
        v_applicant_church_id,
        v_applicant_role,
        v_applicant_status,
        v_applicant_is_blocked
      FROM public.profiles AS p
     WHERE p.id = v_applicant_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Registration applicant profile not found.';
    END IF;

    IF v_applicant_church_id IS DISTINCT FROM p_church_id THEN
        RAISE EXCEPTION
            'The applicant is not linked to this church.';
    END IF;

    IF v_applicant_role IS DISTINCT FROM 'member' THEN
        RAISE EXCEPTION
            'The registration applicant must have the member role before approval.';
    END IF;

    IF v_applicant_status IS DISTINCT FROM 'active'
       OR v_applicant_is_blocked IS DISTINCT FROM false THEN
        RAISE EXCEPTION
            'The registration applicant must have an active, unblocked account.';
    END IF;

    -- Preserve the one-use authorization and role audit mechanism.
    PERFORM public.assign_profile_role(
        v_applicant_id,
        'church_admin'
    );

    -- Keep one consistent 60-day trial period.
    v_trial_start := pg_catalog.clock_timestamp();
    v_trial_end := v_trial_start + INTERVAL '60 days';

    UPDATE public.churches
       SET status = 'approved',
           subscription_status = 'trial',
           trial_ends_at = v_trial_end,
           admin_feedback = NULL
     WHERE id = p_church_id;

    INSERT INTO public.church_subscriptions (
        church_id,
        plan_name,
        currency,
        base_fee,
        included_members,
        additional_member_fee,
        billing_interval,
        status,
        trial_starts_at,
        trial_ends_at,
        next_invoice_at,
        grace_period_days,
        is_internal_test
    )
    VALUES (
        p_church_id,
        'standard',
        'UGX',
        30000,
        100,
        150,
        'monthly',
        'trial',
        v_trial_start,
        v_trial_end,
        v_trial_end,
        7,
        false
    );
END;
$function$;
-- ===== public/functions/assign_profile_role.sql =====
CREATE OR REPLACE FUNCTION public.assign_profile_role (
  p_target_profile_id uuid,
  p_new_role          text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_actor_role text;
    v_actor_church_id uuid;
    v_actor_status text;
    v_actor_is_blocked boolean;
    v_actor_church_status text;
    v_target_role text;
    v_target_church_id uuid;
BEGIN
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required.';
    END IF;

    IF p_target_profile_id IS NULL OR p_new_role IS NULL THEN
        RAISE EXCEPTION 'Target profile and new role are required.';
    END IF;

    IF p_new_role NOT IN (
        'church_admin', 'finance', 'pastor', 'member'
    ) THEN
        RAISE EXCEPTION 'This role is not permitted.';
    END IF;

    SELECT
        p.role,
        p.church_id,
        p.status,
        COALESCE(p.is_blocked, false)
      INTO
        v_actor_role,
        v_actor_church_id,
        v_actor_status,
        v_actor_is_blocked
      FROM public.profiles AS p
     WHERE p.id = v_actor_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Actor profile not found.';
    END IF;

    SELECT p.role, p.church_id
      INTO v_target_role, v_target_church_id
      FROM public.profiles AS p
     WHERE p.id = p_target_profile_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target profile not found.';
    END IF;

    IF public.is_platform_admin(p_target_profile_id) THEN
        RAISE EXCEPTION 'The Super Admin account cannot be changed.';
    END IF;

    IF p_target_profile_id = v_actor_id THEN
        RAISE EXCEPTION 'You cannot change your own role.';
    END IF;

    IF public.is_super_admin() THEN
        NULL;
    ELSIF v_actor_role = 'church_admin' THEN
        IF v_actor_status IS DISTINCT FROM 'active'
           OR v_actor_is_blocked IS DISTINCT FROM false THEN
            RAISE EXCEPTION
                'An active, unblocked Church Admin account is required.';
        END IF;

        SELECT c.status
          INTO v_actor_church_status
          FROM public.churches AS c
         WHERE c.id = v_actor_church_id;

        IF v_actor_church_id IS NULL
           OR v_actor_church_status IS DISTINCT FROM 'approved' THEN
            RAISE EXCEPTION
                'Church Admin access requires an approved assigned church.';
        END IF;

        IF v_target_church_id IS DISTINCT FROM v_actor_church_id THEN
            RAISE EXCEPTION
                'Church Admins may manage only profiles in their own church.';
        END IF;

        IF p_new_role = 'church_admin'
           OR v_target_role IN ('church_admin', 'super_admin') THEN
            RAISE EXCEPTION
                'Only the Super Admin may appoint or change Church Admins.';
        END IF;
    ELSE
        RAISE EXCEPTION 'You are not authorized to assign roles.';
    END IF;

    -- Preserve exact, one-use authorization for non-Super-Admin changes.
    IF NOT public.is_super_admin() THEN
        INSERT INTO private.profile_role_authorizations (
            backend_pid,
            transaction_id,
            actor_id,
            target_profile_id,
            new_role
        )
        VALUES (
            pg_catalog.pg_backend_pid(),
            pg_catalog.txid_current(),
            v_actor_id,
            p_target_profile_id,
            p_new_role
        );
    END IF;

    UPDATE public.profiles
       SET role = p_new_role
     WHERE id = p_target_profile_id;

    INSERT INTO public.role_audit_log (
        actor_id,
        target_profile_id,
        church_id,
        old_role,
        new_role,
        action
    )
    VALUES (
        v_actor_id,
        p_target_profile_id,
        v_target_church_id,
        v_target_role,
        p_new_role,
        'role_change'
    );
END;
$function$;
-- ===== public/functions/can_view_same_church_profile.sql =====
CREATE OR REPLACE FUNCTION public.can_view_same_church_profile (
  p_target_profile_id uuid
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM public.profiles AS viewer
        JOIN public.profiles AS target
          ON target.id = p_target_profile_id
        WHERE viewer.id = auth.uid()
          AND viewer.church_id IS NOT NULL
          AND target.church_id = viewer.church_id
    );
$function$;
-- ===== public/functions/check_event_active_before_registration.sql =====
CREATE OR REPLACE FUNCTION public.check_event_active_before_registration()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
    target_event_date timestamptz;
    event_deadline timestamptz;
BEGIN
    -- Allow ordinary updates when the event does not change.
    IF TG_OP = 'UPDATE'
       AND OLD.event_id IS NOT DISTINCT FROM NEW.event_id THEN
        RETURN NEW;
    END IF;

    -- Read the destination event's date.
    SELECT e.event_date
    INTO target_event_date
    FROM public.events AS e
    WHERE e.id = NEW.event_id;

    -- Let the foreign key reject a nonexistent event.
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- Deadline: midnight UTC after the event's UTC calendar day.
    event_deadline :=
        (((target_event_date AT TIME ZONE 'UTC')::date + 1)::timestamp
          AT TIME ZONE 'UTC');

    IF pg_catalog.clock_timestamp() >= event_deadline THEN
        RAISE EXCEPTION 'Registration closed: This event has ended.';
    END IF;

    RETURN NEW;
END;
$function$;
-- ===== public/functions/check_member_signup_request.sql =====
CREATE OR REPLACE FUNCTION public.check_member_signup_request (
  p_ip_hash   text,
  p_join_code text
)
  RETURNS TABLE (
    request_allowed   boolean,
    church_code_valid boolean
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
    v_attempt_count integer;
    v_normalized_code text;
    v_church_exists boolean := false;
BEGIN
    -- Accept only a SHA-256 hexadecimal fingerprint.
    IF p_ip_hash IS NULL
       OR p_ip_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Invalid signup request fingerprint.';
    END IF;

    -- Atomically allow at most 10 attempts per hour per fingerprint.
    INSERT INTO private.member_signup_rate_limits AS rate_limit (
        ip_hash,
        window_started_at,
        attempt_count
    )
    VALUES (
        p_ip_hash,
        pg_catalog.now(),
        1
    )
    ON CONFLICT (ip_hash) DO UPDATE
       SET window_started_at =
               CASE
                   WHEN rate_limit.window_started_at
                        <= pg_catalog.now() - interval '1 hour'
                   THEN pg_catalog.now()
                   ELSE rate_limit.window_started_at
               END,
           attempt_count =
               CASE
                   WHEN rate_limit.window_started_at
                        <= pg_catalog.now() - interval '1 hour'
                   THEN 1
                   ELSE rate_limit.attempt_count + 1
               END
    RETURNING attempt_count
         INTO v_attempt_count;

    IF v_attempt_count > 10 THEN
        RETURN QUERY SELECT false, false;
        RETURN;
    END IF;

    -- Match the joining RPC's normalization rules.
    v_normalized_code :=
        pg_catalog.upper(
            pg_catalog.btrim(COALESCE(p_join_code, ''))
        );

    IF v_normalized_code = '' THEN
        RETURN QUERY SELECT true, false;
        RETURN;
    END IF;

    -- Only approved churches and their effective join codes qualify.
    SELECT EXISTS (
        SELECT 1
          FROM public.churches AS c
         WHERE c.status = 'approved'
           AND pg_catalog.upper(
                   pg_catalog.btrim(
                       COALESCE(
                           NULLIF(c.join_code, ''),
                           NULLIF(c.code, '')
                       )
                   )
               ) = v_normalized_code
    )
    INTO v_church_exists;

    RETURN QUERY SELECT true, v_church_exists;
END;
$function$;
-- ===== public/functions/create_notification_trigger.sql =====
CREATE OR REPLACE FUNCTION public.create_notification_trigger()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
BEGIN
  -- Insert notification for the message recipient
  INSERT INTO public.notifications (user_id, message, type, is_read)
  VALUES (
    COALESCE(NEW.receiver_id, NEW.recipient_id), -- targets the message recipient
    'You received a new message',
    'message',
    false
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Prevents message sending from failing if notification creation has any error
  RETURN NEW;
END;
$function$;
-- ===== public/functions/enforce_admin_only_event_coupons.sql =====
CREATE OR REPLACE FUNCTION public.enforce_admin_only_event_coupons()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
    caller_role text;
BEGIN
    SELECT p.role
      INTO caller_role
      FROM public.profiles AS p
     WHERE p.id = auth.uid();

    IF caller_role IN ('admin', 'super_admin') THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
IF NEW.coupon_number IS NOT NULL
           OR COALESCE(NEW.amount_paid, 0) <> 0
           OR COALESCE(NEW.is_free, false) <> false THEN
            RAISE EXCEPTION
                'Only administrators can issue coupons or set payment fields.';
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.coupon_number IS DISTINCT FROM OLD.coupon_number
           OR NEW.amount_paid IS DISTINCT FROM OLD.amount_paid
           OR NEW.is_free IS DISTINCT FROM OLD.is_free THEN
            RAISE EXCEPTION
                'Only administrators can modify coupons or payment fields.';
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;
-- ===== public/functions/extend_church_trial.sql =====
CREATE OR REPLACE FUNCTION public.extend_church_trial (
  p_church_id  uuid,
  p_new_expiry timestamp with time zone
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
    v_actor_id uuid := auth.uid();

    v_church_status text;
    v_church_subscription_status text;
    v_church_trial_end timestamptz;

    v_subscription_id uuid;
    v_subscription_status text;
    v_subscription_trial_end timestamptz;
    v_trial_start timestamptz;
BEGIN
    -- Verify designated Super Admin
    IF NOT public.is_super_admin()
    THEN
        RAISE EXCEPTION 'Access denied: Super Admin privileges required';
    END IF;

    -- Validate inputs
    IF p_church_id IS NULL OR p_new_expiry IS NULL THEN
        RAISE EXCEPTION 'Church ID and new expiry date are required';
    END IF;

    -- Lock and inspect the church record
    SELECT
        c.status,
        c.subscription_status,
        c.trial_ends_at
    INTO
        v_church_status,
        v_church_subscription_status,
        v_church_trial_end
    FROM public.churches AS c
    WHERE c.id = p_church_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Church not found';
    END IF;

    IF v_church_status IS DISTINCT FROM 'approved'
       OR v_church_subscription_status IS DISTINCT FROM 'trial'
    THEN
        RAISE EXCEPTION 'Only approved churches on trial can have their trial extended';
    END IF;

    -- Lock and inspect the subscription record
    SELECT
        s.id,
        s.status,
        s.trial_starts_at,
        s.trial_ends_at
    INTO
        v_subscription_id,
        v_subscription_status,
        v_trial_start,
        v_subscription_trial_end
    FROM public.church_subscriptions AS s
    WHERE s.church_id = p_church_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Church subscription record not found';
    END IF;

    IF v_subscription_status IS DISTINCT FROM 'trial' THEN
        RAISE EXCEPTION 'Subscription is not currently on trial';
    END IF;

    -- Prevent expired or shortened trial dates
    IF p_new_expiry <= now() THEN
        RAISE EXCEPTION 'New expiry must be in the future';
    END IF;

    IF v_church_trial_end IS NOT NULL
       AND p_new_expiry <= v_church_trial_end
    THEN
        RAISE EXCEPTION 'New expiry must be later than the current church trial expiry';
    END IF;

    IF v_subscription_trial_end IS NOT NULL
       AND p_new_expiry <= v_subscription_trial_end
    THEN
        RAISE EXCEPTION 'New expiry must be later than the current subscription trial expiry';
    END IF;

    IF v_trial_start IS NOT NULL
       AND p_new_expiry <= v_trial_start
    THEN
        RAISE EXCEPTION 'New expiry must be later than the trial start date';
    END IF;

    -- Update church and subscription together
    UPDATE public.churches
    SET trial_ends_at = p_new_expiry
    WHERE id = p_church_id;

    UPDATE public.church_subscriptions
    SET
        trial_ends_at = p_new_expiry,
        updated_at = now()
    WHERE id = v_subscription_id;

    -- Record the administrative action
    INSERT INTO public.subscription_events (
        church_id,
        subscription_id,
        event_type,
        description,
        actor_user_id,
        metadata
    )
    VALUES (
        p_church_id,
        v_subscription_id,
        'trial_extended',
        'Church trial period extended by Super Admin.',
        v_actor_id,
        jsonb_build_object(
            'previous_church_expiry', v_church_trial_end,
            'previous_subscription_expiry', v_subscription_trial_end,
            'new_expiry', p_new_expiry
        )
    );
END;
$function$;
-- ===== public/functions/get_authorized_church_details.sql =====
CREATE OR REPLACE FUNCTION public.get_authorized_church_details (
  p_church_id uuid
)
  RETURNS TABLE (
    latitude      numeric,
    longitude     numeric,
    trial_ends_at timestamp with time zone
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
    SELECT
        c.latitude,
        c.longitude,
        c.trial_ends_at
    FROM public.churches AS c
    WHERE c.id = p_church_id
      AND (
          public.is_super_admin()
          OR EXISTS (
              SELECT 1
              FROM public.profiles AS p
              INNER JOIN public.churches AS actor_church
                ON actor_church.id = p.church_id
               AND actor_church.status = 'approved'
              WHERE p.id = auth.uid()
                AND p.role = 'church_admin'
                AND p.status = 'active'
                AND COALESCE(p.is_blocked, false) = false
                AND p.church_id = c.id
          )
      );
$function$;
-- ===== public/functions/get_authorized_church_join_code.sql =====
CREATE OR REPLACE FUNCTION public.get_authorized_church_join_code (
  p_church_id uuid DEFAULT NULL::uuid
)
  RETURNS TABLE (
    church_id   uuid,
    church_name text,
    join_code   text
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_actor_role text;
    v_actor_church_id uuid;
    v_actor_status text;
    v_actor_is_blocked boolean;
    v_target_church_id uuid;
BEGIN
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    SELECT
        p.role,
        p.church_id,
        p.status,
        COALESCE(p.is_blocked, false)
      INTO
        v_actor_role,
        v_actor_church_id,
        v_actor_status,
        v_actor_is_blocked
      FROM public.profiles AS p
     WHERE p.id = v_actor_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Profile not found'
            USING ERRCODE = '42501';
    END IF;

    v_actor_role := pg_catalog.lower(COALESCE(v_actor_role, ''));

    IF public.is_super_admin() THEN
        IF p_church_id IS NULL THEN
            RAISE EXCEPTION 'Select a church to retrieve its join code'
                USING ERRCODE = '22023';
        END IF;

        v_target_church_id := p_church_id;

    ELSIF v_actor_role = 'church_admin' THEN
        IF v_actor_status IS DISTINCT FROM 'active'
           OR v_actor_is_blocked IS DISTINCT FROM false THEN
            RAISE EXCEPTION
                'An active, unblocked Church Admin account is required.'
                USING ERRCODE = '42501';
        END IF;

        IF v_actor_church_id IS NULL THEN
            RAISE EXCEPTION 'No assigned church'
                USING ERRCODE = '42501';
        END IF;

        IF p_church_id IS NOT NULL
           AND p_church_id <> v_actor_church_id THEN
            RAISE EXCEPTION 'Not authorized for this church'
                USING ERRCODE = '42501';
        END IF;

        v_target_church_id := v_actor_church_id;
    ELSE
        RAISE EXCEPTION 'Not authorized to access join codes'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        c.id,
        c.name,
        COALESCE(
            NULLIF(c.join_code, ''),
            NULLIF(c.code, '')
        )
    FROM public.churches AS c
    WHERE c.id = v_target_church_id
      AND c.status = 'approved'
      AND COALESCE(
            NULLIF(c.join_code, ''),
            NULLIF(c.code, '')
          ) IS NOT NULL;
END;
$function$;
-- ===== public/functions/get_billable_member_count.sql =====
CREATE OR REPLACE FUNCTION public.get_billable_member_count (
  p_church_id uuid
)
  RETURNS integer
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
    v_count integer;
BEGIN
    IF p_church_id IS NULL THEN
        RAISE EXCEPTION 'Church ID is required';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.churches AS c
        WHERE c.id = p_church_id
    ) THEN
        RAISE EXCEPTION 'Church not found';
    END IF;

    SELECT COUNT(*)::integer
    INTO v_count
    FROM public.profiles AS p
    WHERE p.church_id = p_church_id
      AND p.role = 'member'
      AND p.status = 'active'
      AND COALESCE(p.is_blocked, false) = false;

    RETURN v_count;
END;
$function$;
-- ===== public/functions/get_my_church_application_status.sql =====
CREATE OR REPLACE FUNCTION public.get_my_church_application_status()
  RETURNS TABLE (
    church_id          uuid,
    church_name        text,
    church_location    text,
    church_address     text,
    submitted_at       timestamp with time zone,
    application_status text,
    admin_feedback     text
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
    v_user_id uuid := auth.uid();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        c.id,
        c.name,
        c.location,
        c.address,
        c.created_at,
        c.status,
        c.admin_feedback
    FROM public.churches AS c
    INNER JOIN public.profiles AS p
        ON p.id = v_user_id
       AND p.church_id = c.id
    WHERE c.applicant_user_id = v_user_id
      AND p.status = 'active'
      AND COALESCE(p.is_blocked, false) = false
    ORDER BY c.created_at DESC
    LIMIT 1;
END;
$function$;
-- ===== public/functions/get_my_church_subscription.sql =====
CREATE OR REPLACE FUNCTION public.get_my_church_subscription()
  RETURNS TABLE (
    id                  uuid,
    name                text,
    subscription_status text,
    trial_ends_at       timestamp with time zone
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
    v_church_id uuid;
    v_user_id uuid := auth.uid();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN;
    END IF;

    SELECT p.church_id
      INTO v_church_id
      FROM public.profiles AS p
     WHERE p.id = v_user_id
       AND p.status = 'active'
       AND COALESCE(p.is_blocked, false) = false;

    IF v_church_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        c.id,
        c.name,
        c.subscription_status,
        c.trial_ends_at
    FROM public.churches AS c
    WHERE c.id = v_church_id;
END;
$function$;
-- ===== public/functions/get_super_admin_church_stats.sql =====
CREATE OR REPLACE FUNCTION public.get_super_admin_church_stats()
  RETURNS TABLE (
    total_churches    bigint,
    pending_approvals bigint
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Not authorized to view church statistics';
    END IF;

    RETURN QUERY
    SELECT
        COUNT(*)::bigint,
        COUNT(*) FILTER (
            WHERE c.status IN (
                'pending',
                'changes requested',
                'changes_requested'
            )
        )::bigint
    FROM public.churches AS c;
END;
$function$;
-- ===== public/functions/handle_new_user.sql =====
CREATE OR REPLACE FUNCTION public.handle_new_user()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
BEGIN
    INSERT INTO public.profiles (
        id,
        email,
        full_name,
        role,
        is_admin,
        is_blocked,
        status,
        is_verified,
        verification_type,
        is_approved
    )
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(
            NULLIF(NEW.raw_user_meta_data ->> 'full_name', ''),
            'New User'
        ),
        'member',
        false,
        false,
        'active',
        false,
        'none',
        false
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$function$;
-- ===== public/functions/join_church_by_code.sql =====
CREATE OR REPLACE FUNCTION public.join_church_by_code (
  p_join_code text
)
  RETURNS TABLE (
    church_id   uuid,
    church_name text
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_profile_role text;
    v_profile_status text;
    v_is_blocked boolean;
    v_existing_church_id uuid;
    v_target_church_id uuid;
    v_church_name text;
    v_normalized_code text;
    v_updated_rows integer;
BEGIN
    -- Require an authenticated member.
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = '42501';
    END IF;

    -- Normalize the submitted join code.
    v_normalized_code :=
        pg_catalog.upper(pg_catalog.btrim(COALESCE(p_join_code, '')));

    IF v_normalized_code = '' THEN
        RAISE EXCEPTION 'Please enter a church join code.'
            USING ERRCODE = '22023';
    END IF;

    -- Lock the member's profile and verify eligibility.
    SELECT
        p.role,
        p.status,
        p.is_blocked,
        p.church_id
    INTO
        v_profile_role,
        v_profile_status,
        v_is_blocked,
        v_existing_church_id
    FROM public.profiles AS p
    WHERE p.id = v_actor_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Member profile not found.'
            USING ERRCODE = '42501';
    END IF;

    IF v_profile_role IS DISTINCT FROM 'member' THEN
        RAISE EXCEPTION 'Only member accounts can join a church.'
            USING ERRCODE = '42501';
    END IF;

    IF v_profile_status IS DISTINCT FROM 'active'
       OR COALESCE(v_is_blocked, false) THEN
        RAISE EXCEPTION 'This account is not eligible to join a church.'
            USING ERRCODE = '42501';
    END IF;

    -- Do not allow an ordinary member to switch churches through this function.
    IF v_existing_church_id IS NOT NULL THEN
        RAISE EXCEPTION
            'Your account is already linked to a church. Contact an authorized administrator for reassignment.'
            USING ERRCODE = '22023';
    END IF;

    -- Find and lock the approved church using its effective join code.
    SELECT
        c.id,
        c.name
    INTO
        v_target_church_id,
        v_church_name
    FROM public.churches AS c
    WHERE c.status = 'approved'
      AND pg_catalog.upper(
            pg_catalog.btrim(
                COALESCE(
                    NULLIF(c.join_code, ''),
                    NULLIF(c.code, '')
                )
            )
          ) = v_normalized_code
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid church code or church is not approved.'
            USING ERRCODE = '22023';
    END IF;

    -- Create the one-use authorization required by the existing trigger.
    INSERT INTO private.profile_church_link_authorizations (
        backend_pid,
        transaction_id,
        actor_id,
        target_profile_id,
        church_id
    )
    VALUES (
        pg_catalog.pg_backend_pid(),
        pg_catalog.txid_current(),
        v_actor_id,
        v_actor_id,
        v_target_church_id
    );

    -- Change only church_id. The existing trigger validates and consumes
    -- the one-use authorization record within this transaction.
    UPDATE public.profiles AS p
       SET church_id = v_target_church_id
     WHERE p.id = v_actor_id
       AND p.church_id IS NULL;

    GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

    IF v_updated_rows <> 1 THEN
        RAISE EXCEPTION 'Church membership could not be completed.'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT v_target_church_id, v_church_name;
END;
$function$;
-- ===== public/functions/list_church_applications.sql =====
CREATE OR REPLACE FUNCTION public.list_church_applications()
  RETURNS TABLE (
    application_id      uuid,
    church_name         text,
    church_location     text,
    church_address      text,
    church_description  text,
    submitted_at        timestamp with time zone,
    application_status  text,
    subscription_status text,
    trial_ends_at       timestamp with time zone,
    admin_feedback      text,
    logo_url            text,
    applicant_user_id   uuid,
    applicant_full_name text,
    applicant_email     text
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Not authorized to view church applications';
    END IF;

    RETURN QUERY
    SELECT
        c.id,
        c.name,
        c.location,
        c.address,
        c.description,
        c.created_at,
        c.status,
        c.subscription_status,
        c.trial_ends_at,
        c.admin_feedback,
        c.logo_url,
        c.applicant_user_id,
        p.full_name,
        p.email
    FROM public.churches AS c
    LEFT JOIN public.profiles AS p
        ON p.id = c.applicant_user_id
    WHERE c.status IN (
        'pending',
        'changes requested',
        'changes_requested'
    )
    ORDER BY c.created_at DESC;
END;
$function$;
-- ===== public/functions/moderate_business_listing.sql =====
CREATE OR REPLACE FUNCTION public.moderate_business_listing (
  p_business_id uuid,
  p_status      text,
  p_is_approved boolean
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_actor_role text;
    v_actor_church_id uuid;
    v_actor_status text;
    v_actor_is_blocked boolean;
    v_actor_church_status text;
    v_business_church_id uuid;
    v_status text;
BEGIN
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required.';
    END IF;

    IF p_business_id IS NULL
       OR p_status IS NULL
       OR p_is_approved IS NULL THEN
        RAISE EXCEPTION 'All moderation fields are required.';
    END IF;

    v_status := pg_catalog.lower(pg_catalog.btrim(p_status));

    IF v_status NOT IN ('pending', 'approved', 'rejected') THEN
        RAISE EXCEPTION 'Invalid business status.';
    END IF;

    IF p_is_approved IS DISTINCT FROM (v_status = 'approved') THEN
        RAISE EXCEPTION 'Business status and approval flag conflict.';
    END IF;

    IF NOT public.is_super_admin() THEN
        SELECT
            p.role,
            p.church_id,
            p.status,
            COALESCE(p.is_blocked, false),
            c.status
          INTO
            v_actor_role,
            v_actor_church_id,
            v_actor_status,
            v_actor_is_blocked,
            v_actor_church_status
          FROM public.profiles AS p
          LEFT JOIN public.churches AS c
            ON c.id = p.church_id
         WHERE p.id = v_actor_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Administrator profile not found.';
        END IF;

        IF v_actor_role IS DISTINCT FROM 'church_admin'
           OR v_actor_church_id IS NULL THEN
            RAISE EXCEPTION
                'You are not authorized to moderate businesses.';
        END IF;

        IF v_actor_status IS DISTINCT FROM 'active'
           OR v_actor_is_blocked IS DISTINCT FROM false THEN
            RAISE EXCEPTION
                'An active, unblocked Church Admin account is required.';
        END IF;

        IF v_actor_church_status IS DISTINCT FROM 'approved' THEN
            RAISE EXCEPTION
                'Business moderation requires an approved assigned church.';
        END IF;
    END IF;

    SELECT b.church_id
      INTO v_business_church_id
      FROM public.business_directory AS b
     WHERE b.id = p_business_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Business listing not found.';
    END IF;

    IF NOT public.is_super_admin()
       AND v_actor_church_id IS DISTINCT FROM v_business_church_id THEN
        RAISE EXCEPTION
            'You cannot moderate businesses belonging to another church.';
    END IF;

    UPDATE public.business_directory
       SET status = v_status,
           is_approved = p_is_approved,
           updated_at = pg_catalog.now()
     WHERE id = p_business_id;
END;
$function$;
-- ===== public/functions/prevent_admin_role_change.sql =====
CREATE OR REPLACE FUNCTION public.prevent_admin_role_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$

DECLARE
    v_actor_id uuid := auth.uid();


    v_authorized boolean := false;

BEGIN

    IF (
        NEW.role IS DISTINCT FROM OLD.role
        OR NEW.is_admin IS DISTINCT FROM OLD.is_admin
        OR NEW.church_id IS DISTINCT FROM OLD.church_id
        OR NEW.is_blocked IS DISTINCT FROM OLD.is_blocked
        OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.is_verified IS DISTINCT FROM OLD.is_verified
        OR NEW.verification_type IS DISTINCT FROM OLD.verification_type
        OR NEW.is_approved IS DISTINCT FROM OLD.is_approved
    ) THEN

        IF public.is_super_admin() THEN
            NULL;

        ELSIF
            NEW.role IS DISTINCT FROM OLD.role
            AND NEW.is_admin IS NOT DISTINCT FROM OLD.is_admin
            AND NEW.church_id IS NOT DISTINCT FROM OLD.church_id
            AND NEW.is_blocked IS NOT DISTINCT FROM OLD.is_blocked
            AND NEW.status IS NOT DISTINCT FROM OLD.status
            AND NEW.is_verified IS NOT DISTINCT FROM OLD.is_verified
            AND NEW.verification_type IS NOT DISTINCT FROM OLD.verification_type
            AND NEW.is_approved IS NOT DISTINCT FROM OLD.is_approved
            AND v_actor_id IS NOT NULL
        THEN

            SELECT true INTO v_authorized
            FROM private.profile_role_authorizations a
            WHERE a.backend_pid = pg_catalog.pg_backend_pid()
              AND a.transaction_id = pg_catalog.txid_current()
              AND a.actor_id = v_actor_id
              AND a.target_profile_id = NEW.id
              AND a.new_role = NEW.role
            FOR UPDATE;

            IF NOT COALESCE(v_authorized, false) THEN
                RAISE EXCEPTION
                    'This protected profile change is not authorized.';
            END IF;

            DELETE FROM private.profile_role_authorizations a
            WHERE a.backend_pid = pg_catalog.pg_backend_pid()
              AND a.transaction_id = pg_catalog.txid_current()
              AND a.actor_id = v_actor_id
              AND a.target_profile_id = NEW.id
              AND a.new_role = NEW.role;

        ELSIF
            NEW.church_id IS DISTINCT FROM OLD.church_id
            AND NEW.role IS NOT DISTINCT FROM OLD.role
            AND NEW.is_admin IS NOT DISTINCT FROM OLD.is_admin
            AND NEW.is_blocked IS NOT DISTINCT FROM OLD.is_blocked
            AND NEW.status IS NOT DISTINCT FROM OLD.status
            AND NEW.is_verified IS NOT DISTINCT FROM OLD.is_verified
            AND NEW.verification_type IS NOT DISTINCT FROM OLD.verification_type
            AND NEW.is_approved IS NOT DISTINCT FROM OLD.is_approved
            AND v_actor_id = NEW.id
        THEN

            SELECT true INTO v_authorized
            FROM private.profile_church_link_authorizations a
            WHERE a.backend_pid = pg_catalog.pg_backend_pid()
              AND a.transaction_id = pg_catalog.txid_current()
              AND a.actor_id = v_actor_id
              AND a.target_profile_id = NEW.id
              AND a.church_id = NEW.church_id
            FOR UPDATE;

            IF NOT COALESCE(v_authorized, false) THEN
                RAISE EXCEPTION
                    'This protected profile change is not authorized.';
            END IF;

            DELETE FROM private.profile_church_link_authorizations a
            WHERE a.backend_pid = pg_catalog.pg_backend_pid()
              AND a.transaction_id = pg_catalog.txid_current()
              AND a.actor_id = v_actor_id
              AND a.target_profile_id = NEW.id
              AND a.church_id = NEW.church_id;

        ELSE
            RAISE EXCEPTION
                'This protected profile change is not authorized.';
        END IF;
    END IF;


    -- Protect both spellings of the global Super Admin role.
    IF NEW.role IN ('super_admin', 'super-admin')
       AND NOT public.is_platform_admin(NEW.id) THEN

        RAISE EXCEPTION
            'Super Admin privileges cannot be assigned to another account.';
    END IF;


    -- Preserve the designated account's canonical role.
    IF public.is_platform_admin(NEW.id)
       AND NEW.role IS DISTINCT FROM 'super_admin' THEN

        RAISE EXCEPTION
            'The designated Super Admin role cannot be removed here.';
    END IF;

    RETURN NEW;

END;

$function$;
-- ===== public/functions/reject_church_application.sql =====
CREATE OR REPLACE FUNCTION public.reject_church_application (
  p_church_id uuid,
  p_feedback  text DEFAULT NULL::text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_status text;
    v_applicant_id uuid;
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Super Admin required.';
    END IF;

    SELECT c.status, c.applicant_user_id
      INTO v_status, v_applicant_id
      FROM public.churches AS c
     WHERE c.id = p_church_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Church registration request not found.';
    END IF;

    IF v_status IS NULL
       OR v_status NOT IN ('pending', 'changes requested') THEN
        RAISE EXCEPTION
            'This church registration is not awaiting review.';
    END IF;

    IF v_applicant_id IS NULL THEN
        RAISE EXCEPTION
            'This record has no registration applicant.';
    END IF;

    UPDATE public.churches
       SET status = 'rejected',
           subscription_status = 'rejected',
           admin_feedback = NULLIF(pg_catalog.btrim(p_feedback), '')
     WHERE id = p_church_id;
END;
$function$;
-- ===== public/functions/request_changes_church_application.sql =====
CREATE OR REPLACE FUNCTION public.request_changes_church_application (
  p_church_id uuid,
  p_feedback  text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_status text;
    v_applicant_id uuid;
    v_feedback text;
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Super Admin required.';
    END IF;

    v_feedback := NULLIF(pg_catalog.btrim(p_feedback), '');

    IF v_feedback IS NULL THEN
        RAISE EXCEPTION 'Feedback cannot be blank.';
    END IF;

    SELECT c.status, c.applicant_user_id
      INTO v_status, v_applicant_id
      FROM public.churches AS c
     WHERE c.id = p_church_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Church registration request not found.';
    END IF;

    IF v_status IS NULL
       OR v_status NOT IN ('pending', 'changes requested') THEN
        RAISE EXCEPTION
            'This church registration is not awaiting review.';
    END IF;

    IF v_applicant_id IS NULL THEN
        RAISE EXCEPTION
            'This record has no registration applicant.';
    END IF;

    UPDATE public.churches
       SET status = 'changes requested',
           subscription_status = 'pending',
           admin_feedback = v_feedback
     WHERE id = p_church_id;
END;
$function$;
-- ===== public/functions/submit_church_application.sql =====
CREATE OR REPLACE FUNCTION public.submit_church_application (
  p_name           text,
  p_location       text DEFAULT NULL::text,
  p_address        text DEFAULT NULL::text,
  p_logo_url       text DEFAULT NULL::text,
  p_admin_position text DEFAULT NULL::text
)
  RETURNS TABLE (
    church_id uuid,
    join_code text
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_profile_role text;
    v_profile_church_id uuid;
    v_is_admin boolean;
    v_is_blocked boolean;
    v_status text;
    v_church_id uuid;
    v_join_code text;
    v_prefix text;
BEGIN
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Please sign in before submitting a church application.';
    END IF;

    IF p_name IS NULL OR pg_catalog.btrim(p_name) = '' THEN
        RAISE EXCEPTION 'Church name is required.';
    END IF;

    SELECT p.role, p.church_id, p.is_admin, p.is_blocked, p.status
    INTO v_profile_role, v_profile_church_id,
         v_is_admin, v_is_blocked, v_status
    FROM public.profiles p
    WHERE p.id = v_actor_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Your profile is not ready. Please try again after signing in.';
    END IF;

    IF v_profile_role IS DISTINCT FROM 'member'
       OR COALESCE(v_is_admin, false)
       OR COALESCE(v_is_blocked, false)
       OR v_status IS DISTINCT FROM 'active'
       OR v_profile_church_id IS NOT NULL THEN
        RAISE EXCEPTION 'This account is not eligible to submit a new church application.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.churches c
        WHERE c.applicant_user_id = v_actor_id
          AND c.status IN ('pending', 'changes requested', 'approved')
    ) THEN
        RAISE EXCEPTION 'You already have a pending or approved church application.';
    END IF;

    v_prefix := pg_catalog.upper(
        pg_catalog.substr(
            pg_catalog.regexp_replace(p_name, '[^a-zA-Z0-9]', '', 'g'),
            1, 4
        )
    );

    IF v_prefix = '' THEN
        v_prefix := 'CHUR';
    END IF;

    LOOP
        v_join_code := v_prefix || pg_catalog.upper(
            pg_catalog.substr(
                pg_catalog.md5(
                    pg_catalog.random()::text ||
                    pg_catalog.clock_timestamp()::text
                ), 1, 6
            )
        );

        EXIT WHEN NOT EXISTS (
            SELECT 1 FROM public.churches c
            WHERE c.join_code = v_join_code
        );
    END LOOP;

    INSERT INTO public.churches (
        name, location, address, join_code, applicant_user_id,
        subscription_status, trial_ends_at, logo_url, status
    )
    VALUES (
        pg_catalog.btrim(p_name),
        NULLIF(pg_catalog.btrim(COALESCE(p_location, '')), ''),
        NULLIF(pg_catalog.btrim(COALESCE(p_address, '')), ''),
        v_join_code,
        v_actor_id,
        'pending_trial',
        NULL,
        NULLIF(pg_catalog.btrim(COALESCE(p_logo_url, '')), ''),
        'pending'
    )
    RETURNING id INTO v_church_id;

    INSERT INTO private.profile_church_link_authorizations (
        backend_pid, transaction_id, actor_id, target_profile_id, church_id
    )
    VALUES (
        pg_catalog.pg_backend_pid(),
        pg_catalog.txid_current(),
        v_actor_id,
        v_actor_id,
        v_church_id
    );

    UPDATE public.profiles
    SET church_id = v_church_id,
        position = NULLIF(pg_catalog.btrim(COALESCE(p_admin_position, '')), '')
    WHERE id = v_actor_id;

    RETURN QUERY SELECT v_church_id, v_join_code;
END;
$function$;
-- ===== public/functions/super_admin_list_churches.sql =====
CREATE OR REPLACE FUNCTION public.super_admin_list_churches()
  RETURNS TABLE (
    id            uuid,
    name          text,
    trial_ends_at timestamp with time zone
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
BEGIN
    -- Allow only the designated Super Admin
    IF NOT public.is_super_admin()
    THEN
        RAISE EXCEPTION 'Access denied: Super Admin privileges required';
    END IF;

    RETURN QUERY
    SELECT
        c.id,
        c.name,
        c.trial_ends_at
    FROM public.churches AS c
    ORDER BY c.name;
END;
$function$;
-- ===== public/functions/super_admin_update_user_role.sql =====
CREATE OR REPLACE FUNCTION public.super_admin_update_user_role (
  target_user_id uuid,
  new_role       text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
BEGIN
    -- Only the designated Super Admin may use this dashboard function.
    IF NOT public.is_super_admin()
    THEN
        RAISE EXCEPTION 'Access denied: Super Admin privileges required';
    END IF;

    -- Delegate to the existing protected role-assignment function.
    PERFORM public.assign_profile_role(
        target_user_id,
        new_role
    );
END;
$function$;
-- ===== public/functions/update_updated_at_column.sql =====
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$;
-- ===== public/views/church_directory.sql =====
CREATE VIEW "public"."church_directory" WITH (security_barrier=true) AS  SELECT id,
    name,
    location,
    description,
    created_at,
    latitude,
    longitude,
    address,
    logo_url,
    live_stream_id,
    is_live
   FROM public.churches
  WHERE (status = 'approved'::text);
-- ===== public/views/church_volunteer_roster.sql =====
CREATE VIEW "public"."church_volunteer_roster" WITH (security_barrier=true) AS  SELECT id,
    title,
    description,
    event_date,
    church_id,
    max_capacity,
    is_active
   FROM public.volunteer_roster;
-- ===== DEFERRED TRIGGERS =====
CREATE TRIGGER enforce_admin_only_event_coupons
  BEFORE INSERT OR UPDATE ON public.event_registrations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_admin_only_event_coupons();
CREATE TRIGGER tr_check_event_active_registration
  BEFORE INSERT OR UPDATE ON public.event_registrations
  FOR EACH ROW
  EXECUTE FUNCTION public.check_event_active_before_registration();
CREATE TRIGGER notify_new_message
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.create_notification_trigger();
-- Profile protection trigger deferred until Staging Super Admin setup.

CREATE TRIGGER set_transactions_updated_at
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
-- ===== AUTH SIGNUP TRIGGER =====
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
-- ===== DEFERRED SECURITY WORK =====
-- Restore reviewed RLS policies and least-privilege grants separately.
-- Attach prevent_admin_role_change() after Staging Super Admin setup.
-- Create Storage buckets and policies separately.
-- The violations_view is intentionally excluded pending redesign.
-- FOUNDATION DRAFT ONLY: DO NOT EXECUTE YET.

-- 8. EXPLICIT FUNCTION EXECUTE ALLOWLIST
--
-- Browser RPCs called by the reviewed Staging frontend receive EXECUTE only
-- for the exact signatures listed below. Their SECURITY DEFINER bodies must
-- retain their own authentication/authorization checks.
--
-- The Edge Function member-signup uses its service-role admin client for the
-- atomic signup rate-limit RPC. That function is service_role-only.
--
-- Do not add get_billable_member_count(), can_view_same_church_profile(),
-- is_platform_admin(), or the is_super_admin(uuid) overload: no reviewed
-- browser/backend caller requires them. Internal/trigger functions remain
-- ungranted. The Section 02/03 RLS helper functions are created in their own
-- policy drafts and retain their narrow grants there.
-- ---------------------------------------------------------------------------

-- Remove inherited or earlier grants for every function in this allowlist.
REVOKE ALL ON FUNCTION public.is_super_admin()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.approve_church_application(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.assign_profile_role(uuid, text)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.extend_church_trial(uuid, timestamp with time zone)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_authorized_church_details(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_authorized_church_join_code(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_my_church_application_status()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_my_church_subscription()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_super_admin_church_stats()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.join_church_by_code(text)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_church_applications()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.moderate_business_listing(uuid, text, boolean)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reject_church_application(uuid, text)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.request_changes_church_application(uuid, text)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.submit_church_application(text, text, text, text, text)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.super_admin_list_churches()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.super_admin_update_user_role(uuid, text)
    FROM PUBLIC, anon, authenticated, service_role;
-- The UUID overload and internal/unused helpers remain unavailable directly.
REVOKE ALL ON FUNCTION public.is_super_admin(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_billable_member_count(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.can_view_same_church_profile(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
-- The Edge Function's service-role client is the only direct caller.
REVOKE ALL ON FUNCTION public.check_member_signup_request(text, text)
    FROM PUBLIC, anon, authenticated, service_role;
-- ------------------------------------------------------------
-- Trigger-only functions: no direct API EXECUTE permissions.
-- Existing triggers are declared above. The deferred profile
-- protection trigger must be attached by an appropriately
-- privileged owner after Staging Super Admin setup.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.check_event_active_before_registration()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_notification_trigger()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_admin_only_event_coupons()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.handle_new_user()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prevent_admin_role_change()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_updated_at_column()
    FROM PUBLIC, anon, authenticated, service_role;
-- Exact browser RPC allowlist. No anonymous RPCs are granted here.
GRANT EXECUTE ON FUNCTION public.is_super_admin()
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_church_application(uuid)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_profile_role(uuid, text)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.extend_church_trial(uuid, timestamp with time zone)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_authorized_church_details(uuid)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_authorized_church_join_code(uuid)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_church_application_status()
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_church_subscription()
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_super_admin_church_stats()
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_church_by_code(text)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_church_applications()
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.moderate_business_listing(uuid, text, boolean)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_church_application(uuid, text)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_changes_church_application(uuid, text)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_church_application(text, text, text, text, text)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.super_admin_list_churches()
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.super_admin_update_user_role(uuid, text)
    TO authenticated;
-- Backend-only signup rate-limit RPC.
GRANT EXECUTE ON FUNCTION public.check_member_signup_request(text, text)
    TO service_role;
-- End of merged draft.
-- Section 8 explicitly revokes inherited EXECUTE privileges and grants
-- only the reviewed authenticated and service-role permissions.;
