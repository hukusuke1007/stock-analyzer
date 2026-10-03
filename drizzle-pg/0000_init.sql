CREATE TABLE "judgments" (
	"user_id" text NOT NULL,
	"strategy" text NOT NULL,
	"code" text NOT NULL,
	"judged_at" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "judgments_user_id_strategy_code_pk" PRIMARY KEY("user_id","strategy","code")
);
--> statement-breakpoint
CREATE TABLE "screen_results" (
	"screen_id" text NOT NULL,
	"user_id" text NOT NULL,
	"position" integer NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "screen_results_screen_id_position_pk" PRIMARY KEY("screen_id","position")
);
--> statement-breakpoint
CREATE TABLE "screens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"strategy" text NOT NULL,
	"scanned_at" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"initial_cash" double precision NOT NULL,
	"cash" double precision NOT NULL,
	"revision" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_positions" (
	"user_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"shares" integer NOT NULL,
	"avg_price" double precision NOT NULL,
	"opened_at" text NOT NULL,
	"plan" jsonb,
	CONSTRAINT "sim_positions_user_id_code_pk" PRIMARY KEY("user_id","code")
);
--> statement-breakpoint
CREATE TABLE "sim_trades" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"at" text NOT NULL,
	"side" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"shares" integer NOT NULL,
	"price" double precision NOT NULL,
	"price_date" text NOT NULL,
	"amount" double precision NOT NULL,
	"realized" double precision
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"decisions_provider" text NOT NULL,
	"codex_model" text NOT NULL,
	"notify_take_profit" boolean DEFAULT false NOT NULL,
	"notify_stop_loss" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "watchlists" (
	"user_id" text PRIMARY KEY NOT NULL,
	"codes" jsonb NOT NULL,
	"columns" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "judgments" ADD CONSTRAINT "judgments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screen_results" ADD CONSTRAINT "screen_results_screen_id_screens_id_fk" FOREIGN KEY ("screen_id") REFERENCES "public"."screens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screen_results" ADD CONSTRAINT "screen_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screens" ADD CONSTRAINT "screens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_accounts" ADD CONSTRAINT "sim_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_positions" ADD CONSTRAINT "sim_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_trades" ADD CONSTRAINT "sim_trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "screen_results_user_idx" ON "screen_results" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "screens_user_strategy_idx" ON "screens" USING btree ("user_id","strategy","scanned_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sim_trades_user_idx" ON "sim_trades" USING btree ("user_id","at");