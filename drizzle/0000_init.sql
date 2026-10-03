CREATE TABLE `judgments` (
	`user_id` text NOT NULL,
	`strategy` text NOT NULL,
	`code` text NOT NULL,
	`judged_at` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`user_id`, `strategy`, `code`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `screen_results` (
	`screen_id` text NOT NULL,
	`user_id` text NOT NULL,
	`position` integer NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`screen_id`, `position`),
	FOREIGN KEY (`screen_id`) REFERENCES `screens`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `screen_results_user_idx` ON `screen_results` (`user_id`);--> statement-breakpoint
CREATE TABLE `screens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`strategy` text NOT NULL,
	`scanned_at` text NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `screens_user_strategy_idx` ON `screens` (`user_id`,`strategy`,`scanned_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `sim_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`initial_cash` real NOT NULL,
	`cash` real NOT NULL,
	`revision` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sim_positions` (
	`user_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`shares` integer NOT NULL,
	`avg_price` real NOT NULL,
	`opened_at` text NOT NULL,
	`plan` text,
	PRIMARY KEY(`user_id`, `code`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sim_trades` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`at` text NOT NULL,
	`side` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`shares` integer NOT NULL,
	`price` real NOT NULL,
	`price_date` text NOT NULL,
	`amount` real NOT NULL,
	`realized` real,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sim_trades_user_idx` ON `sim_trades` (`user_id`,`at`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`decisions_provider` text NOT NULL,
	`codex_model` text NOT NULL,
	`notify_take_profit` integer DEFAULT false NOT NULL,
	`notify_stop_loss` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `watchlists` (
	`user_id` text PRIMARY KEY NOT NULL,
	`codes` text NOT NULL,
	`columns` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
