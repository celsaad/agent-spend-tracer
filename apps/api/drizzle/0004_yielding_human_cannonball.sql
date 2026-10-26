DROP TABLE `spends`;--> statement-breakpoint
ALTER TABLE `decisions` ADD `denied_at` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `submitted_at` text;--> statement-breakpoint
ALTER TABLE `transfers` ADD `confirmed_at` text;