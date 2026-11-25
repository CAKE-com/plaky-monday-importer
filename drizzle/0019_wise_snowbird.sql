CREATE TABLE `unanswered_writes` (
	`migration_id` integer NOT NULL,
	`plaky_space_id` integer NOT NULL,
	`plaky_board_id` integer NOT NULL,
	`monday_item_id` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`plaky_space_id`, `plaky_board_id`, `monday_item_id`),
	FOREIGN KEY (`migration_id`) REFERENCES `migrations`(`id`) ON UPDATE no action ON DELETE cascade
);
