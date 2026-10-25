-- Verified quality reports of rendered ads (idempotent).
CREATE TABLE IF NOT EXISTS "quality_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "public"."projects"("id") ON DELETE cascade,
	"render_job_id" uuid,
	"kind" text DEFAULT 'render' NOT NULL,
	"score" integer NOT NULL,
	"status" text NOT NULL,
	"measurements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"identity" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"identity_source" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_reports_project_idx" ON "quality_reports" USING btree ("project_id","created_at");
