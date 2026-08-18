# Dispatch Coinbase OAuth by stored intent

TaxMaxi keeps Coinbase's legacy `/cdp/callback` because the callback registered in the Coinbase developer portal cannot currently be changed. The callback dispatches from its stored OAuth intent so login and identity-linking remain distinct; both ensure the user's Coinbase source exists, while syncing remains an explicit user action.
