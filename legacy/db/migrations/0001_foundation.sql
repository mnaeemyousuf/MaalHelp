-- PostgreSQL foundation. Apply through a migration runner in deployment.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE TYPE inventory_status AS ENUM ('available','reserved','damaged','quarantine','expired','in_transit','blocked');
CREATE TYPE movement_type AS ENUM ('opening_balance','receipt','putaway','pick','dispatch','transfer','adjustment','damage','return','stock_count','write_off','consumption');

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, legal_name text,
  country_code char(2) NOT NULL DEFAULT 'PK', currency_code char(3) NOT NULL DEFAULT 'PKR',
  timezone text NOT NULL DEFAULT 'Asia/Karachi', status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email citext UNIQUE NOT NULL,
  password_hash text NOT NULL, full_name text NOT NULL, phone text,
  status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  key text NOT NULL, name text NOT NULL, permissions jsonb NOT NULL DEFAULT '[]', is_system boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id,key), UNIQUE (id,tenant_id)
);
CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, role_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active', warehouse_scope uuid[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (role_id,tenant_id) REFERENCES roles(id,tenant_id), UNIQUE(tenant_id,user_id), UNIQUE(id,tenant_id)
);
CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL, name text NOT NULL, address text, city text, country_code char(2) NOT NULL DEFAULT 'PK',
  capacity numeric(18,4), capacity_unit text, manager_membership_id uuid, status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,code), UNIQUE(id,tenant_id),
  FOREIGN KEY(manager_membership_id,tenant_id) REFERENCES memberships(id,tenant_id)
);
CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, warehouse_id uuid NOT NULL,
  parent_id uuid, code text NOT NULL, name text NOT NULL, kind text NOT NULL CHECK(kind IN ('zone','aisle','rack','shelf','bin')),
  barcode text, capacity numeric(18,4), capacity_unit text, temperature_zone text, status text NOT NULL DEFAULT 'active',
  UNIQUE(tenant_id,warehouse_id,code), UNIQUE(id,tenant_id),
  FOREIGN KEY(warehouse_id,tenant_id) REFERENCES warehouses(id,tenant_id),
  FOREIGN KEY(parent_id,tenant_id) REFERENCES locations(id,tenant_id)
);
CREATE UNIQUE INDEX locations_barcode_tenant_uq ON locations(tenant_id,barcode) WHERE barcode IS NOT NULL;
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku text NOT NULL, name text NOT NULL, category text, brand text, description text, uom text NOT NULL DEFAULT 'ea',
  cost_price numeric(18,4) NOT NULL DEFAULT 0, sale_price numeric(18,4) NOT NULL DEFAULT 0,
  min_stock numeric(18,4) NOT NULL DEFAULT 0, reorder_level numeric(18,4) NOT NULL DEFAULT 0, reorder_qty numeric(18,4) NOT NULL DEFAULT 0,
  weight numeric(18,4), length numeric(18,4), width numeric(18,4), height numeric(18,4),
  track_batch boolean NOT NULL DEFAULT false, track_serial boolean NOT NULL DEFAULT false, track_expiry boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,sku), UNIQUE(id,tenant_id)
);
CREATE TABLE product_barcodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, product_id uuid NOT NULL,
  value text NOT NULL, symbology text NOT NULL DEFAULT 'CODE128', is_primary boolean NOT NULL DEFAULT false,
  FOREIGN KEY(product_id,tenant_id) REFERENCES products(id,tenant_id), UNIQUE(tenant_id,value)
);
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL, name text NOT NULL, phone text, email text, address text, city text,
  credit_limit numeric(18,2) NOT NULL DEFAULT 0, payment_terms_days integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'active',
  UNIQUE(tenant_id,code), UNIQUE(id,tenant_id)
);
CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL, name text NOT NULL, phone text, email text, address text, city text,
  payment_terms_days integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'active', UNIQUE(tenant_id,code), UNIQUE(id,tenant_id)
);
CREATE TABLE inventory_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, owner_id uuid, warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL, product_id uuid NOT NULL, lot_code text NOT NULL DEFAULT '', serial_code text NOT NULL DEFAULT '',
  status inventory_status NOT NULL DEFAULT 'available', quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK(quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(warehouse_id,tenant_id) REFERENCES warehouses(id,tenant_id), FOREIGN KEY(location_id,tenant_id) REFERENCES locations(id,tenant_id),
  FOREIGN KEY(product_id,tenant_id) REFERENCES products(id,tenant_id), UNIQUE(tenant_id,owner_id,location_id,product_id,lot_code,serial_code,status), UNIQUE(id,tenant_id)
);
CREATE INDEX inventory_product_idx ON inventory_balances(tenant_id,product_id,status);
CREATE INDEX inventory_location_idx ON inventory_balances(tenant_id,warehouse_id,location_id);
CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, balance_id uuid NOT NULL,
  type movement_type NOT NULL, quantity_delta numeric(18,4) NOT NULL CHECK(quantity_delta <> 0),
  reference_type text, reference_id uuid, from_location_id uuid, to_location_id uuid, lot_code text, serial_code text,
  unit_cost numeric(18,4), note text, actor_membership_id uuid NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(balance_id,tenant_id) REFERENCES inventory_balances(id,tenant_id),
  FOREIGN KEY(actor_membership_id,tenant_id) REFERENCES memberships(id,tenant_id)
);
CREATE INDEX movement_ledger_idx ON inventory_movements(tenant_id,balance_id,occurred_at DESC);
CREATE TABLE sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, order_no text NOT NULL, customer_id uuid NOT NULL,
  warehouse_id uuid NOT NULL, status text NOT NULL DEFAULT 'draft', currency char(3) NOT NULL DEFAULT 'PKR',
  total numeric(18,2) NOT NULL DEFAULT 0, promised_at timestamptz, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(customer_id,tenant_id) REFERENCES customers(id,tenant_id), FOREIGN KEY(warehouse_id,tenant_id) REFERENCES warehouses(id,tenant_id),
  FOREIGN KEY(created_by,tenant_id) REFERENCES memberships(id,tenant_id), UNIQUE(tenant_id,order_no), UNIQUE(id,tenant_id)
);
CREATE TABLE sales_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, order_id uuid NOT NULL, product_id uuid NOT NULL,
  quantity numeric(18,4) NOT NULL CHECK(quantity > 0), fulfilled_quantity numeric(18,4) NOT NULL DEFAULT 0,
  unit_price numeric(18,4) NOT NULL, FOREIGN KEY(order_id,tenant_id) REFERENCES sales_orders(id,tenant_id),
  FOREIGN KEY(product_id,tenant_id) REFERENCES products(id,tenant_id)
);
CREATE TABLE receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, receipt_no text NOT NULL, supplier_id uuid,
  warehouse_id uuid NOT NULL, status text NOT NULL DEFAULT 'draft', received_at timestamptz,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(supplier_id,tenant_id) REFERENCES suppliers(id,tenant_id), FOREIGN KEY(warehouse_id,tenant_id) REFERENCES warehouses(id,tenant_id),
  FOREIGN KEY(created_by,tenant_id) REFERENCES memberships(id,tenant_id), UNIQUE(tenant_id,receipt_no), UNIQUE(id,tenant_id)
);
CREATE TABLE receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, receipt_id uuid NOT NULL, product_id uuid NOT NULL,
  quantity_expected numeric(18,4), quantity_received numeric(18,4) NOT NULL DEFAULT 0, quantity_damaged numeric(18,4) NOT NULL DEFAULT 0,
  lot_code text, expires_at date, FOREIGN KEY(receipt_id,tenant_id) REFERENCES receipts(id,tenant_id), FOREIGN KEY(product_id,tenant_id) REFERENCES products(id,tenant_id)
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_membership_id uuid, action text NOT NULL, entity_type text NOT NULL, entity_id uuid,
  old_value jsonb, new_value jsonb, request_id text, ip_address inet, device text, occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(actor_membership_id,tenant_id) REFERENCES memberships(id,tenant_id)
);
CREATE INDEX audit_tenant_time_idx ON audit_events(tenant_id,occurred_at DESC);
-- Application database role should be granted INSERT/SELECT on audit_events, with no UPDATE/DELETE.
