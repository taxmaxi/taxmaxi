# Context Map

## Contexts

- [Core](./packages/core/CONTEXT.md) — defines shared tax, monetary, and account access concepts
- [Web Application](./apps/www/CONTEXT.md) — presents TaxMaxi workflows to people using the web app

## Relationships

- **Core → Asset identity**: Core distinguishes fiat monetary denominations from economic assets.
- **Core → Persistence**: Account identities are stored by the persistence package.
- **Core → REST API**: Authentication endpoints expose account access and login-method management.
- **Web Application → Asset identity**: The web application presents provider observations and records administrator decisions through the asset review API.
- **Web Application → Account access**: Login, recovery, and settings flows let people access and manage their account.
