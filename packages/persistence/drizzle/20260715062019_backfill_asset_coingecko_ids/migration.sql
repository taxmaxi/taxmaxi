UPDATE "assets"
SET "coingecko_coin_id" = 'solana'
WHERE "blockchain_id" IN (SELECT "id" FROM "blockchains" WHERE "name" = 'solana')
	AND "contract_address" IS NULL
	AND upper("symbol") = 'SOL';--> statement-breakpoint
UPDATE "assets"
SET "coingecko_coin_id" = 'usd-coin'
WHERE "blockchain_id" IN (SELECT "id" FROM "blockchains" WHERE "name" = 'solana')
	AND "contract_address" = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';--> statement-breakpoint
UPDATE "assets"
SET "coingecko_coin_id" = 'tether'
WHERE "blockchain_id" IN (SELECT "id" FROM "blockchains" WHERE "name" = 'solana')
	AND "contract_address" = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
