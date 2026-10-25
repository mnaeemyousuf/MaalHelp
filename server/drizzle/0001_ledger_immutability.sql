-- Inventory ledger and audit log are append-only. Corrections are recorded as
-- new movements / new audit rows, never by editing history.
CREATE OR REPLACE FUNCTION stockpilot_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER inventory_transactions_immutable
  BEFORE UPDATE OR DELETE ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION stockpilot_block_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION stockpilot_block_mutation();
--> statement-breakpoint
-- Balances can never go negative, regardless of code path.
ALTER TABLE inventory_balances ADD CONSTRAINT inventory_balances_non_negative CHECK (quantity >= 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS products_search_idx ON products (tenant_id, lower(sku), lower(name));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customers_search_idx ON customers (tenant_id, lower(name));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS suppliers_search_idx ON suppliers (tenant_id, lower(name));
