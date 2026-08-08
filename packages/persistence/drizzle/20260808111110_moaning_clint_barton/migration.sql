ALTER TABLE "provider_transfers" DROP CONSTRAINT "provider_transfers_observed_representation_complete", ADD CONSTRAINT "provider_transfers_observed_representation_complete" CHECK ((
        "observed_representation_type" is null
        and "observed_blockchain_id" is null
        and "observed_contract_address" is null
        and "observed_mint_address" is null
        and "observed_decimals" is null
      ) or (
        "observed_representation_type" is null
        and "observed_blockchain_id" is not null
        and num_nonnulls("observed_contract_address", "observed_mint_address") = 1
      ) or (
        "observed_representation_type" = 'native'
        and "observed_blockchain_id" is not null
        and "observed_contract_address" is null
        and "observed_mint_address" is null
      ) or (
        "observed_representation_type" in ('token', 'nft')
        and "observed_blockchain_id" is not null
        and num_nonnulls("observed_contract_address", "observed_mint_address") = 1
      ));