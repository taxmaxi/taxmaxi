# Require explicit login-method linking

TaxMaxi treats an email match during logged-out authentication as an account collision, not proof that a new identity belongs to the existing account. Another Google, Coinbase, or password identity may be attached to an existing account only from an authenticated Settings session with recent verification of the account email; this adds friction but avoids exposing financial data after email reassignment or an unverified provider claim.
