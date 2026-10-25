# Database design

The initial PostgreSQL migration is `db/migrations/0001_foundation.sql`.

## Isolation

Each tenant-owned row contains `tenant_id`. Composite unique keys and composite foreign keys ensure that a child cannot point to a parent in another tenant. Every request resolves tenant scope from a validated membership. SQL statements must include that scope. Production may additionally enable PostgreSQL row-level security with a transaction-local tenant setting.

## Inventory truth

`inventory_balances` is the current, query-efficient quantity by owner, physical location, product, lot/serial and status. `inventory_movements` is the append-only ledger. Update a balance and append its ledger movement atomically, under a row lock. Corrections are compensating movements; never edit or delete historical movements. Reservation is represented by status/quantity and must not exceed available stock. Transfers post equal and opposite movements sharing a transfer reference.

## Extensions planned

Follow-up migrations add purchase orders, reservation allocations, counts/variances/approvals, putaway and picking tasks, packing/shipment entities, returns, expenses, storage billing, subscriptions, integration/webhook records and AI usage. Monetary values use decimal numeric columns with currency codes; quantities use decimal numeric columns and explicit units. Tax configuration is data-driven and country-specific rather than embedded in calculation code.

## Operations

Use migration tooling with checksums and forward-only production migrations. Index tenant-scoped lookup and reporting paths. Back up with point-in-time recovery. Restrict the API database role from updating/deleting ledger and audit rows; give migration jobs a separate schema-owner credential.
