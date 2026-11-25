DROP INDEX `mb_migration_plaky`;--> statement-breakpoint
CREATE INDEX `mb_migration_plaky` ON `migration_boards` (`migration_id`,`plaky_board_id`);