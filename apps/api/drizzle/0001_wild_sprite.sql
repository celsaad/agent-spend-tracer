CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`wallet_address` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`mandate_id` text NOT NULL,
	`amount` integer NOT NULL,
	`recipient` text NOT NULL,
	`verdict` text NOT NULL,
	`created_at` text NOT NULL,
	`approved_at` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mandate_id`) REFERENCES `mandates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `decisions_agent_created_idx` ON `decisions` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mandates` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`currency` text DEFAULT 'USDC' NOT NULL,
	`per_tx_limit` integer NOT NULL,
	`rolling_30d_limit` integer NOT NULL,
	`review_threshold` integer NOT NULL,
	`allowed_recipients` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mandates_agent_created_idx` ON `mandates` (`agent_id`,`created_at`);