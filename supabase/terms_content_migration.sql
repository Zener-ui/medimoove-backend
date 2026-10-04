-- ============================================================
-- TERMS OF SERVICE — REAL DRAFT CONTENT
-- Run this in Supabase SQL Editor AFTER operational_migrations.sql
-- (the policies table and its placeholder seed rows are created
-- there).
--
-- WHY: policies.terms_of_service previously held literal placeholder
-- text ("Terms of service content goes here.") — meaning every
-- checkbox anyone ever ticked at signup agreed to nothing. This
-- replaces it with a real draft covering the actual operational
-- scenarios of the platform (cancellation windows, spoiled-goods
-- liability, rider independent-contractor status, force majeure,
-- etc).
--
-- STILL NOT LEGALLY REVIEWED. This is a strong, realistic starting
-- draft, not a finished legal instrument — get a Nigerian lawyer to
-- review it (NDPR compliance especially, given NIN and location data
-- are collected) before treating it as final. Bumping the version to
-- 0.1-draft below is deliberate, so it's visibly distinct from a
-- reviewed 1.0 release once that happens — update both `content` and
-- `version` again at that point.
-- ============================================================

UPDATE policies
SET
  content = $POLICY$Fidelx Platform Terms of Service (Draft — not yet legally reviewed)

1. WHAT FIDELX IS
Fidelx is a technology platform that connects independent local vendors, independent delivery riders, and customers. Fidelx does not manufacture, grow, cook, package, or sell any of the goods listed on the platform. Every product, its price, its description, and its availability is controlled entirely by the vendor who listed it. Fidelx's role is limited to facilitating discovery, processing payment, coordinating delivery logistics, and holding funds in escrow until a delivery is confirmed.

2. ACCOUNTS AND ELIGIBILITY
Information you provide at registration (name, phone, email, and — for riders — NIN for identity verification) must be accurate. Providing false identity information is grounds for immediate account termination. One person, one account per role.

3. CUSTOMER TERMS

3.1 Ordering and Pricing
All prices, descriptions, and photos are vendor-controlled. If a vendor is out of stock after you've ordered, you're entitled to a full refund for that item.

3.2 Cancellation Window
You may cancel an order only before the vendor begins preparing it. Once an order enters preparing status, cancellation is no longer available through the app, and no refund is issued for that reason alone.

3.3 Delivery vs. Pickup
Once a rider has been assigned and is en route to the vendor, the order can no longer be cancelled.

3.4 Problems With What You Received
If an item arrives spoiled, damaged, incorrect, or missing, raise a dispute through the Fidelx Dispute Dashboard within 2 hours of delivery, with photo evidence where applicable.
- Vendor's fault (spoiled, expired, wrong item, poor packaging): full refund, vendor bears the cost.
- Rider's fault (confirmed mishandling, excessive unexplained delay): Fidelx investigates and may refund from platform funds while separately resolving the matter with the rider.
- Nobody's fault (genuine fragility, force majeure): Fidelx may offer a partial refund or credit at its discretion; this is not automatic.

3.5 Availability at Delivery
You're responsible for being reachable at the address you provided. A documented failed delivery attempt due to your unavailability may not be free.

4. VENDOR TERMS

4.1 Listing Accuracy and Food Safety
You are solely responsible for the accuracy of your listings and for complying with applicable food safety, hygiene, and licensing requirements.

4.2 When You're on the Hook
If you fulfill an order with a spoiled, expired, materially different, or poorly-packaged-and-damaged item, you bear the full cost of the customer refund and any required redelivery.

4.3 Prohibited Items
No counterfeit goods, falsely-represented expired products, illegal substances, weapons, or anything prohibited under Nigerian law. Fidelx may delist products and suspend accounts without notice for violations.

4.4 Payout Cycle
Cleared balances are aggregated and disbursed weekly (currently Tuesdays). Funds clear 24 hours after delivery confirmation.

5. RIDER TERMS

5.1 Independent Contractor Status
Riders are independent contractors, not employees, agents, or staff. You are responsible for your own vehicle, fuel, maintenance, roadworthiness documents, and license. Fidelx does not cover medical costs, vehicle damage, or third-party liability arising from your use of a vehicle while delivering.

5.2 What You Actually Get Paid
The delivery fee shown to the customer includes a Fidelx delivery margin (currently ₦100 per completed delivery). Your payout is the delivery fee minus this margin, and should be shown consistently everywhere your earnings appear in the app.

5.3 When You're Not Paid For a Delivery
If a delivery is confirmed as damaged or mishandled due to your own negligence, Fidelx may withhold or reverse that delivery's payout while the dispute is resolved. Other completed deliveries are unaffected.

5.4 Safety
You are not required to accept a delivery you consider unsafe. Declining on safety grounds does not count against your account standing.

6. DISPUTES
Disputes must go through the in-app Dispute Dashboard within the timeframes stated above. Fidelx's decision resolves the transaction on the platform; it does not limit anyone's right to pursue the matter through ordinary legal channels.

7. PAYMENTS
All payments are processed through Paystack. Fidelx holds funds in escrow from payment until delivery confirmation.

8. FORCE MAJEURE
Fidelx, vendors, and riders are not liable for delays or failures caused by events beyond reasonable control — severe weather, fuel scarcity, civil unrest, road closures, network outages, or government action.

9. LIMITATION OF LIABILITY
To the maximum extent permitted by law, Fidelx's total liability to any user for any claim is limited to the value of the order in question. Fidelx is not liable for indirect, incidental, or consequential damages.

10. DATA & PRIVACY
Fidelx collects the data necessary to operate the platform, including delivery location data and, for riders, NIN for identity verification. See the separate Privacy Policy for detail.

11. CHANGES TO THESE TERMS
Fidelx may update these terms. Material changes will be presented for re-acceptance; continued use after a change constitutes acceptance.

12. GOVERNING LAW
These terms are governed by the laws of the Federal Republic of Nigeria.$POLICY$,
  version = '0.1-draft',
  updated_at = NOW()
WHERE type = 'terms_of_service';
