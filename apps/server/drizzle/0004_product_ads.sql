-- Product ads from real footage: brand kits, campaigns, footage segment catalog (idempotent).
CREATE TABLE IF NOT EXISTS "brand_kits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"logo_asset_id" uuid REFERENCES "public"."assets"("id") ON DELETE set null,
	"colors" jsonb DEFAULT '{"primary":"#7C5CFF","secondary":"#111111","text":"#FFFFFF"}'::jsonb NOT NULL,
	"fonts" jsonb DEFAULT '{"heading":"black","body":"semibold"}'::jsonb NOT NULL,
	"voice" text DEFAULT '' NOT NULL,
	"products" text DEFAULT '' NOT NULL,
	"ctas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"slogans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"handles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"website" text,
	"music_style" text DEFAULT '' NOT NULL,
	"offers" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_kits_user_idx" ON "brand_kits" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"brand_kit_id" uuid REFERENCES "public"."brand_kits"("id") ON DELETE set null,
	"title" text DEFAULT 'New ad' NOT NULL,
	"brief" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"phase" text,
	"progress" real,
	"analysis" jsonb,
	"plan" jsonb,
	"project_id" uuid REFERENCES "public"."projects"("id") ON DELETE set null,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_campaigns_user_idx" ON "ad_campaigns" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "footage_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL REFERENCES "public"."ad_campaigns"("id") ON DELETE cascade,
	"asset_id" uuid NOT NULL REFERENCES "public"."assets"("id") ON DELETE cascade,
	"role" text DEFAULT 'footage' NOT NULL,
	"index" integer NOT NULL,
	"start_sec" real NOT NULL,
	"end_sec" real NOT NULL,
	"frame_asset_id" uuid REFERENCES "public"."assets"("id") ON DELETE set null,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"duplicate_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "footage_segments_campaign_idx" ON "footage_segments" USING btree ("campaign_id","index");
