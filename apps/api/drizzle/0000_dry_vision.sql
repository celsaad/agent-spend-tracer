CREATE TABLE `spends` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tx_hash` text NOT NULL,
	`to` text NOT NULL,
	`amount` text NOT NULL,
	`memo` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spends_tx_hash_unique` ON `spends` (`tx_hash`);