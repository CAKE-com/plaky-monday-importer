CREATE TABLE `file_map` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`migration_id` integer NOT NULL,
	`monday_item_id` text NOT NULL,
	`monday_asset_id` text NOT NULL,
	`occurrence` integer DEFAULT 0 NOT NULL,
	`plaky_item_id` integer NOT NULL,
	`plaky_file_id` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`migration_id`) REFERENCES `migrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fm_unique` ON `file_map` (`migration_id`,`monday_item_id`,`monday_asset_id`,`occurrence`);