CREATE TABLE `indexer_state` (
	`key` text PRIMARY KEY NOT NULL,
	`last_block` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`tx_hash` text NOT NULL,
	`log_index` integer NOT NULL,
	`block_number` integer NOT NULL,
	`block_hash` text NOT NULL,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`amount` text NOT NULL,
	`status` text NOT NULL,
	`authorization` text,
	`decision_id` text,
	`seen_at` text NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transfers_tx_hash_idx` ON `transfers` (`tx_hash`);--> statement-breakpoint
CREATE INDEX `transfers_block_idx` ON `transfers` (`block_number`);