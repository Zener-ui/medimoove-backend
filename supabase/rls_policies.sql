-- ============================================================
-- CARTMOOVE RLS POLICIES
-- Paste into Supabase SQL Editor and run AFTER schema.sql
-- ============================================================

-- Enable RLS on every table
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE riders ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sub_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE faq_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- HELPER FUNCTION: get current user role
-- ============================================================
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS TEXT AS $$
  SELECT role FROM users WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- USERS
-- ============================================================
-- Users can read their own record only
CREATE POLICY "users_select_own" ON users
  FOR SELECT USING (id = auth.uid());

-- Users can update their own record
CREATE POLICY "users_update_own" ON users
  FOR UPDATE USING (id = auth.uid());

-- Admins can read all users
CREATE POLICY "users_admin_select_all" ON users
  FOR SELECT USING (get_user_role() = 'admin');

-- Admins can update any user (suspend, activate)
CREATE POLICY "users_admin_update_all" ON users
  FOR UPDATE USING (get_user_role() = 'admin');

-- Anyone can register (insert)
CREATE POLICY "users_insert_public" ON users
  FOR INSERT WITH CHECK (true);

-- ============================================================
-- REGIONS
-- ============================================================
-- Public can read active regions
CREATE POLICY "regions_select_public" ON regions
  FOR SELECT USING (is_active = true);

-- Admins can do everything
CREATE POLICY "regions_admin_all" ON regions
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- DELIVERY SETTINGS
-- ============================================================
-- Public can read delivery settings (needed for fee estimate at checkout)
CREATE POLICY "delivery_settings_select_public" ON delivery_settings
  FOR SELECT USING (true);

-- Only admins can modify
CREATE POLICY "delivery_settings_admin_all" ON delivery_settings
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- FEE SETTINGS
-- ============================================================
-- Public can read (needed to show fee preview)
CREATE POLICY "fee_settings_select_public" ON fee_settings
  FOR SELECT USING (true);

-- Only admins can modify
CREATE POLICY "fee_settings_admin_all" ON fee_settings
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- VENDORS
-- ============================================================
-- Anyone can browse approved vendors
CREATE POLICY "vendors_select_approved_public" ON vendors
  FOR SELECT USING (status = 'approved');

-- Vendors can read their own profile regardless of status
CREATE POLICY "vendors_select_own" ON vendors
  FOR SELECT USING (user_id = auth.uid());

-- Vendors can update their own profile
CREATE POLICY "vendors_update_own" ON vendors
  FOR UPDATE USING (user_id = auth.uid());

-- Vendors can insert their own profile
CREATE POLICY "vendors_insert_own" ON vendors
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Admins can do everything
CREATE POLICY "vendors_admin_all" ON vendors
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- RIDERS
-- ============================================================
-- Riders can read their own profile
CREATE POLICY "riders_select_own" ON riders
  FOR SELECT USING (user_id = auth.uid());

-- Riders can update their own profile (location, availability)
CREATE POLICY "riders_update_own" ON riders
  FOR UPDATE USING (user_id = auth.uid());

-- Riders can insert their own profile
CREATE POLICY "riders_insert_own" ON riders
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Admins can do everything
CREATE POLICY "riders_admin_all" ON riders
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- PRODUCTS
-- ============================================================
-- Anyone can browse available products
CREATE POLICY "products_select_public" ON products
  FOR SELECT USING (is_available = true AND stock_quantity > 0);

-- Vendors can see all their own products (including unavailable)
CREATE POLICY "products_select_own_vendor" ON products
  FOR SELECT USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

-- Vendors can insert their own products
CREATE POLICY "products_insert_own" ON products
  FOR INSERT WITH CHECK (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

-- Vendors can update their own products
CREATE POLICY "products_update_own" ON products
  FOR UPDATE USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

-- Vendors can delete their own products
CREATE POLICY "products_delete_own" ON products
  FOR DELETE USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

-- Admins can do everything
CREATE POLICY "products_admin_all" ON products
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- PRODUCT VARIANTS
-- ============================================================
-- Public can read variants of available products
CREATE POLICY "variants_select_public" ON product_variants
  FOR SELECT USING (
    product_id IN (SELECT id FROM products WHERE is_available = true)
  );

-- Vendors can manage their own product variants
CREATE POLICY "variants_vendor_all" ON product_variants
  FOR ALL USING (
    product_id IN (
      SELECT p.id FROM products p
      JOIN vendors v ON p.vendor_id = v.id
      WHERE v.user_id = auth.uid()
    )
  );

-- Admins can do everything
CREATE POLICY "variants_admin_all" ON product_variants
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- INVENTORY RESERVATIONS
-- ============================================================
-- Only the system (service role) and admins touch this table
CREATE POLICY "inventory_reservations_admin_all" ON inventory_reservations
  FOR ALL USING (get_user_role() = 'admin');

-- Vendors can view reservations on their products
CREATE POLICY "inventory_reservations_vendor_select" ON inventory_reservations
  FOR SELECT USING (
    product_id IN (
      SELECT p.id FROM products p
      JOIN vendors v ON p.vendor_id = v.id
      WHERE v.user_id = auth.uid()
    )
  );

-- ============================================================
-- ORDERS (main orders)
-- ============================================================
-- Customers can read their own orders
CREATE POLICY "orders_select_own_customer" ON orders
  FOR SELECT USING (customer_id = auth.uid());

-- Customers can insert orders
CREATE POLICY "orders_insert_customer" ON orders
  FOR INSERT WITH CHECK (customer_id = auth.uid());

-- Customers can update their own orders (cancel)
CREATE POLICY "orders_update_own_customer" ON orders
  FOR UPDATE USING (customer_id = auth.uid());

-- Admins can do everything
CREATE POLICY "orders_admin_all" ON orders
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- SUB ORDERS
-- ============================================================
-- Customers can read sub-orders for their own orders
CREATE POLICY "sub_orders_select_customer" ON sub_orders
  FOR SELECT USING (
    order_id IN (SELECT id FROM orders WHERE customer_id = auth.uid())
  );

-- Vendors can read their own sub-orders
CREATE POLICY "sub_orders_select_vendor" ON sub_orders
  FOR SELECT USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

-- Vendors can update their own sub-orders (mark ready for pickup)
CREATE POLICY "sub_orders_update_vendor" ON sub_orders
  FOR UPDATE USING (
    vendor_id IN (SELECT id FROM vendors WHERE user_id = auth.uid())
  );

-- Riders can read their assigned sub-orders
CREATE POLICY "sub_orders_select_rider" ON sub_orders
  FOR SELECT USING (
    rider_id IN (SELECT id FROM riders WHERE user_id = auth.uid())
  );

-- Riders can update their assigned sub-orders (accept, picked up, delivered)
CREATE POLICY "sub_orders_update_rider" ON sub_orders
  FOR UPDATE USING (
    rider_id IN (SELECT id FROM riders WHERE user_id = auth.uid())
    OR rider_id IS NULL -- Allows accepting unassigned orders
  );

-- Admins can do everything
CREATE POLICY "sub_orders_admin_all" ON sub_orders
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- ORDER ITEMS
-- ============================================================
-- Customers can read their own order items
CREATE POLICY "order_items_select_customer" ON order_items
  FOR SELECT USING (
    order_id IN (SELECT id FROM orders WHERE customer_id = auth.uid())
  );

-- Vendors can read items in their sub-orders
CREATE POLICY "order_items_select_vendor" ON order_items
  FOR SELECT USING (
    sub_order_id IN (
      SELECT id FROM sub_orders WHERE vendor_id IN (
        SELECT id FROM vendors WHERE user_id = auth.uid()
      )
    )
  );

-- Riders can read items in their deliveries
CREATE POLICY "order_items_select_rider" ON order_items
  FOR SELECT USING (
    sub_order_id IN (
      SELECT id FROM sub_orders WHERE rider_id IN (
        SELECT id FROM riders WHERE user_id = auth.uid()
      )
    )
  );

-- Admins can do everything
CREATE POLICY "order_items_admin_all" ON order_items
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- PAYMENTS
-- ============================================================
-- Customers can read their own payments
CREATE POLICY "payments_select_own_customer" ON payments
  FOR SELECT USING (
    order_id IN (SELECT id FROM orders WHERE customer_id = auth.uid())
  );

-- Admins can do everything
CREATE POLICY "payments_admin_all" ON payments
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- BALANCES
-- ============================================================
-- Users can only read their own balance
CREATE POLICY "balances_select_own" ON balances
  FOR SELECT USING (user_id = auth.uid());

-- Only the system (service role) and admins can modify balances
CREATE POLICY "balances_admin_all" ON balances
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- WITHDRAWALS
-- ============================================================
-- Users can read their own withdrawals
CREATE POLICY "withdrawals_select_own" ON withdrawals
  FOR SELECT USING (requester_id = auth.uid());

-- Users can insert their own withdrawal requests
CREATE POLICY "withdrawals_insert_own" ON withdrawals
  FOR INSERT WITH CHECK (requester_id = auth.uid());

-- Admins can do everything
CREATE POLICY "withdrawals_admin_all" ON withdrawals
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- LEDGER ENTRIES (immutable — no one should edit or delete)
-- ============================================================
-- Users can read their own ledger entries
CREATE POLICY "ledger_select_own" ON ledger_entries
  FOR SELECT USING (actor_id = auth.uid()::text);

-- No one can update or delete ledger entries — append only
-- Admins can read everything
CREATE POLICY "ledger_admin_select_all" ON ledger_entries
  FOR SELECT USING (get_user_role() = 'admin');

-- ============================================================
-- REFUNDS
-- ============================================================
-- Customers can read their own refunds
CREATE POLICY "refunds_select_own_customer" ON refunds
  FOR SELECT USING (customer_id = auth.uid());

-- Customers can create refund requests
CREATE POLICY "refunds_insert_customer" ON refunds
  FOR INSERT WITH CHECK (customer_id = auth.uid());

-- Admins can do everything
CREATE POLICY "refunds_admin_all" ON refunds
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- RECEIPTS
-- ============================================================
-- Users can read their own receipts
CREATE POLICY "receipts_select_own" ON receipts
  FOR SELECT USING (user_id = auth.uid());

-- Admins can read all receipts
CREATE POLICY "receipts_admin_all" ON receipts
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- REVIEWS
-- ============================================================
-- Anyone can read reviews (public trust signal)
CREATE POLICY "reviews_select_public" ON reviews
  FOR SELECT USING (true);

-- Customers can create reviews for their own delivered orders
CREATE POLICY "reviews_insert_customer" ON reviews
  FOR INSERT WITH CHECK (customer_id = auth.uid());

-- Admins can do everything
CREATE POLICY "reviews_admin_all" ON reviews
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- DISPUTES
-- ============================================================
-- Customers can read their own disputes
CREATE POLICY "disputes_select_own_customer" ON disputes
  FOR SELECT USING (customer_id = auth.uid());

-- Customers can create disputes
CREATE POLICY "disputes_insert_customer" ON disputes
  FOR INSERT WITH CHECK (customer_id = auth.uid());

-- Customers can update their own disputes (add appeal evidence)
CREATE POLICY "disputes_update_own_customer" ON disputes
  FOR UPDATE USING (customer_id = auth.uid());

-- Vendors can read disputes related to their orders
CREATE POLICY "disputes_select_vendor" ON disputes
  FOR SELECT USING (
    order_id IN (
      SELECT o.id FROM orders o
      JOIN sub_orders so ON so.order_id = o.id
      JOIN vendors v ON so.vendor_id = v.id
      WHERE v.user_id = auth.uid()
    )
  );

-- Admins can do everything
CREATE POLICY "disputes_admin_all" ON disputes
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
-- Users can read their own notifications
CREATE POLICY "notifications_select_own" ON notifications
  FOR SELECT USING (user_id = auth.uid()::text);

-- Users can update their own (mark as read)
CREATE POLICY "notifications_update_own" ON notifications
  FOR UPDATE USING (user_id = auth.uid()::text);

-- Admins can do everything
CREATE POLICY "notifications_admin_all" ON notifications
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- SUPPORT TICKETS
-- ============================================================
-- Users can read their own tickets
CREATE POLICY "tickets_select_own" ON support_tickets
  FOR SELECT USING (user_id = auth.uid());

-- Users can create tickets
CREATE POLICY "tickets_insert_own" ON support_tickets
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can update their own tickets (add replies)
CREATE POLICY "tickets_update_own" ON support_tickets
  FOR UPDATE USING (user_id = auth.uid());

-- Admins can do everything
CREATE POLICY "tickets_admin_all" ON support_tickets
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- FAQ ENTRIES
-- ============================================================
-- Anyone can read active FAQs
CREATE POLICY "faq_select_public" ON faq_entries
  FOR SELECT USING (is_active = true);

-- Admins can manage FAQs
CREATE POLICY "faq_admin_all" ON faq_entries
  FOR ALL USING (get_user_role() = 'admin');

-- ============================================================
-- AUDIT LOGS
-- ============================================================
-- Only admins can read audit logs
CREATE POLICY "audit_logs_admin_select" ON audit_logs
  FOR SELECT USING (get_user_role() = 'admin');

-- No one can edit or delete audit logs — ever
-- Inserts happen via service role only
