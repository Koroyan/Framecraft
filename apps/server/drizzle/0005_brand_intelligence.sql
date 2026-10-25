-- Brand intelligence, product catalog, resumable uploads, creative concepts (idempotent).
ALTER TABLE "brand_kits" ADD COLUMN IF NOT EXISTS "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN IF NOT EXISTS "industry" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN IF NOT EXISTS "audience" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN IF NOT EXISTS "markets" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN IF NOT EXISTS "languages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN IF NOT EXISTS "contact" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN IF NOT EXISTS "restrictions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN IF NOT EXISTS "vocabulary" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN IF NOT EXISTS "knowledge" jsonb DEFAULT '{"facts":[],"sources":[]}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"brand_kit_id" uuid NOT NULL REFERENCES "public"."brand_kits"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"price" text DEFAULT '' NOT NULL,
	"url" text,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"media_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_products_brand_idx" ON "brand_products" USING btree ("brand_kit_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"filename" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"received_bytes" bigint DEFAULT 0 NOT NULL,
	"chunk_size" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"fields" jsonb NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"asset_id" uuid REFERENCES "public"."assets"("id") ON DELETE set null,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_sessions_user_idx" ON "upload_sessions" USING btree ("user_id","fingerprint");--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD COLUMN IF NOT EXISTS "product_id" uuid REFERENCES "public"."brand_products"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD COLUMN IF NOT EXISTS "concepts" jsonb;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD COLUMN IF NOT EXISTS "review" jsonb;
