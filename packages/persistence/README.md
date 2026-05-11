# persistence

TaxMaxi persistence layer.

`@my/persistence` owns schema, SQL, and repository implementations. Source sync orchestration and provider-specific sync logic live in `@my/sync-engine`; persistence only provides the repository layers those modules consume.
