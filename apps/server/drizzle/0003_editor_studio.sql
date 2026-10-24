-- Editor studio: immutable shot versions, edit operations and review comments (idempotent).
ALTER TYPE "public"."job_kind" ADD VALUE IF NOT EXISTS 'edit';--> statement-breakpoint
ALTER TABLE "shots" ADD COLUMN IF NOT EXISTS "active_version_id" uuid;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shot_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "public"."projects"("id") ON DELETE cascade,
	"shot_id" uuid NOT NULL REFERENCES "public"."shots"("id") ON DELETE cascade,
	"number" integer NOT NULL,
	"asset_id" uuid NOT NULL REFERENCES "public"."assets"("id") ON DELETE cascade,
	"parent_version_id" uuid,
	"label" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"operation_id" uuid,
	"prompt" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shot_versions_number_idx" ON "shot_versions" USING btree ("shot_id","number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shot_versions_project_idx" ON "shot_versions" USING btree ("project_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edit_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "public"."projects"("id") ON DELETE cascade,
	"shot_id" uuid NOT NULL REFERENCES "public"."shots"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"source_version_id" uuid NOT NULL,
	"result_version_id" uuid,
	"comment_id" uuid,
	"kind" text DEFAULT 'ai_edit' NOT NULL,
	"mode" text NOT NULL,
	"instruction" text DEFAULT '' NOT NULL,
	"start_sec" real NOT NULL,
	"end_sec" real NOT NULL,
	"mask" jsonb,
	"reference_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"keyframe_asset_id" uuid,
	"keyframe_sec" real,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"generation_job_id" uuid,
	"estimate_credits" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edit_operations_shot_idx" ON "edit_operations" USING btree ("shot_id","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shot_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "public"."projects"("id") ON DELETE cascade,
	"shot_id" uuid NOT NULL REFERENCES "public"."shots"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
	"version_id" uuid,
	"parent_id" uuid,
	"author" text DEFAULT 'user' NOT NULL,
	"text" text NOT NULL,
	"start_sec" real,
	"end_sec" real,
	"x" real,
	"y" real,
	"mask" jsonb,
	"reference_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"operation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shot_comments_shot_idx" ON "shot_comments" USING btree ("shot_id","created_at");
