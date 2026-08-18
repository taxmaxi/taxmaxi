# Core

Core defines the shared tax, monetary, and account concepts used throughout TaxMaxi.

## Tax and monetary language

**Supported fiat currency**:
A fiat monetary denomination that TaxMaxi recognizes by its canonical ISO currency code. It is not an economic asset and has no network representation.
_Avoid_: Fiat asset, canonical asset

**Fiat observation**:
A fiat currency description received from a provider's dedicated fiat catalog. An exact supported currency code resolves without provider asset review; unknown or conflicting evidence fails closed.
_Avoid_: Provider asset

## Account language

**Account**:
A person's TaxMaxi membership and data. One account can have multiple login methods.
_Avoid_: Identity, login

**Account email**:
The lowercase canonical address where TaxMaxi sends security and recovery messages. It does not have to match the address reported by a linked login provider.
_Avoid_: Provider email, login identity

**Login method**:
A verified way to access an account, such as Google, Coinbase, or email and password. An account's login methods are peers; none is primary.
_Avoid_: Account, provider account, source connection

**Identity**:
The link between an account and one provider-specific login method. Attaching another identity to an existing account requires the person to authenticate that account first.
_Avoid_: Account

**Provider email**:
The address reported by an OAuth provider for a linked identity. It is display metadata, not the identity's stable key or necessarily the account email.
_Avoid_: Account email, provider ID

**Account collision**:
A logged-out login or sign-up attempt whose email matches an existing account but whose identity is not yet linked. An email match detects the collision but does not prove account ownership.
_Avoid_: Automatic linking

**Password reset**:
Recovery of an existing email-and-password login method. It never creates the first password for an account.
_Avoid_: Add password, account linking

**Sign-in help**:
A privacy-preserving email flow that explains how to access an existing account. It resets an existing password when possible or points the person to their linked OAuth providers, but never creates a login method.
_Avoid_: Forgot password

**Add password**:
Creation of an account's first email-and-password login method from an authenticated session. It requires a fresh verification code sent to the account email.
_Avoid_: Password reset, registration

**Login-method change**:
Adding or removing an account identity. Every login-method change requires an authenticated session with recent security verification and must leave at least one login method linked. Removing one ends sessions authenticated through that method.
_Avoid_: Profile update

**Security verification**:
A short-lived confirmation of account-email access tied to the current authenticated session. One confirmation can authorize login-method changes for ten minutes.
_Avoid_: Email verification status, login session

**Source connection**:
An exchange account or wallet connected so TaxMaxi can import tax data. It is stored separately from login methods even when one Coinbase OAuth flow creates both.
_Avoid_: Login method, identity
