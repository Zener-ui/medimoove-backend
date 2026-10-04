const { adminClient } = require("../config/db");

const getDeliverySettings = async (region_id) => {
  const { data } = await adminClient.from("delivery_settings").select("*").eq("region_id", region_id).single();
  return {
    base_fee: data?.base_fee ?? 300,
    rate_per_km: data?.rate_per_km ?? 100,
    fuel_multiplier: data?.fuel_multiplier ?? 1.1,
    minimum_delivery_fee: data?.minimum_delivery_fee ?? 300,
    maximum_delivery_radius: data?.maximum_delivery_radius ?? 30,
    delivery_margin: data?.delivery_margin ?? 100,
    large_package_fee: data?.large_package_fee ?? 200,
    rush_fee: data?.rush_fee ?? 150,
    peak_hour_multiplier: data?.peak_hour_multiplier ?? 1.2,
    rain_surcharge: data?.rain_surcharge ?? 100,
    peak_hours_enabled: data?.peak_hours_enabled ?? true,
    rain_surcharge_enabled: data?.rain_surcharge_enabled ?? false,
    manual_override_fee: data?.manual_override_fee ?? null,
  };
};

// A vendor may narrow their own delivery radius below the region cap
// (see vendorController.updateVendorProfile, which enforces they can
// never set it ABOVE the region max) — this is the one place that
// resolves "region max vs vendor's own override" into the actual
// number eligibility checks should use, so estimateDeliveryFee and
// order creation can't drift out of sync with each other.
const getEffectiveDeliveryRadius = (vendor, settings) => {
  if (vendor?.delivery_radius_km && vendor.delivery_radius_km < settings.maximum_delivery_radius) {
    return vendor.delivery_radius_km;
  }
  return settings.maximum_delivery_radius;
};

// Peak hours: 7am-9am and 5pm-8pm
const isPeakHour = () => {
  const hour = new Date().getHours();
  return (hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 20);
};

const calculateDeliveryFee = (distanceKm, settings, options = {}) => {
  const { is_large_package = false, is_rush = false } = options;
  const {
    base_fee, rate_per_km, fuel_multiplier,
    minimum_delivery_fee, delivery_margin,
    peak_hour_multiplier, rain_surcharge,
    peak_hours_enabled, rain_surcharge_enabled,
    manual_override_fee,
  } = settings;

  // Admin override takes priority over everything
  if (manual_override_fee !== null && manual_override_fee > 0) {
    return {
      delivery_fee: manual_override_fee,
      delivery_margin,
      rider_payout: manual_override_fee - delivery_margin,
      distance_km: distanceKm,
      breakdown: { override: true, override_fee: manual_override_fee },
    };
  }

  let fee = (base_fee + distanceKm * rate_per_km) * fuel_multiplier;

  if (is_large_package) fee += settings.large_package_fee;
  if (is_rush) fee += settings.rush_fee;

  // Peak hour surcharge
  const peakApplied = peak_hours_enabled && isPeakHour();
  if (peakApplied) fee *= peak_hour_multiplier;

  // Rain surcharge (toggled manually by admin)
  const rainApplied = rain_surcharge_enabled;
  if (rainApplied) fee += rain_surcharge;

  // Round up to nearest 50
  fee = Math.ceil(fee / 50) * 50;
  fee = Math.max(fee, minimum_delivery_fee);

  const rider_payout = fee - delivery_margin;

  return {
    delivery_fee: fee,
    delivery_margin,
    rider_payout,
    distance_km: distanceKm,
    breakdown: {
      base_fee,
      distance_component: distanceKm * rate_per_km,
      fuel_multiplier,
      peak_applied: peakApplied,
      peak_multiplier: peakApplied ? peak_hour_multiplier : null,
      rain_applied: rainApplied,
      rain_surcharge: rainApplied ? rain_surcharge : null,
      large_package: is_large_package,
      rush: is_rush,
    },
  };
};

// @route GET /api/delivery/estimate
const estimateDeliveryFee = async (req, res) => {
  try {
    const { vendor_id, delivery_lat, delivery_lng, is_large_package, is_rush } = req.query;

    const { data: vendor } = await adminClient.from("vendors").select("id, business_name, region_id, location_lat, location_lng, delivery_radius_km").eq("id", vendor_id).single();
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found." });

    // Without this explicit check, missing vendor coordinates get
    // silently coerced to (0,0) inside the Haversine math below,
    // producing a huge-but-real-looking distance — which then trips
    // the "outside service radius" error further down. That message is
    // actively misleading (it blames the customer's address when the
    // real problem is the vendor never set a location), so catch it
    // here with an accurate message instead.
    if (!vendor.location_lat || !vendor.location_lng) {
      return res.status(400).json({
        success: false,
        message: `"${vendor.business_name}" hasn't set up their store location yet, so delivery pricing isn't available from them right now.`,
      });
    }

    const parsedLat = parseFloat(delivery_lat);
    const parsedLng = parseFloat(delivery_lng);

    // Similarly, a missing/malformed delivery_lat or delivery_lng
    // becomes NaN here — and "NaN > radius" is always false in JS, so
    // the radius check below would silently pass straight through and
    // produce a NaN-based fee instead of a clear error.
    if (Number.isNaN(parsedLat) || Number.isNaN(parsedLng)) {
      return res.status(400).json({
        success: false,
        message: "A valid delivery location is required to estimate the fee.",
      });
    }

    const distanceKm = haversineDistance(vendor.location_lat, vendor.location_lng, parsedLat, parsedLng);
    const settings = await getDeliverySettings(vendor.region_id);
    const effectiveRadius = getEffectiveDeliveryRadius(vendor, settings);

    if (distanceKm > effectiveRadius) {
      return res.status(400).json({ success: false, message: `Delivery address is outside the ${effectiveRadius}km service radius.` });
    }

    const estimate = calculateDeliveryFee(distanceKm, settings, {
      is_large_package: is_large_package === "true",
      is_rush: is_rush === "true",
    });

    res.json({ success: true, estimate });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/delivery/admin/toggle-rain-surcharge
// @route GET /api/delivery/admin/settings
// Every active region plus its effective delivery settings (falling
// back to the same defaults getDeliverySettings/calculateDeliveryFee
// already use if a region has no settings row yet), so the admin UI
// always has something real to show and edit, not a blank state for
// a region that just hasn't been configured yet.
const getAllDeliverySettings = async (req, res) => {
  try {
    const { data: regions, error } = await adminClient
      .from("regions")
      .select("id, name, state, is_active")
      .order("name");
    if (error) throw error;

    const withSettings = await Promise.all(
      (regions || []).map(async (region) => ({
        ...region,
        settings: await getDeliverySettings(region.id),
      }))
    );

    res.json({ success: true, regions: withSettings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const toggleRainSurcharge = async (req, res) => {
  try {
    const { region_id, enabled } = req.body;
    // Upsert, not update — a region with no delivery_settings row yet
    // (previously every region) would have silently matched zero rows
    // here and reported success while changing nothing. See
    // fix_delivery_settings_upsert.sql for the matching schema fix
    // (unique constraint on region_id) this relies on.
    const { error } = await adminClient
      .from("delivery_settings")
      .upsert({ region_id, rain_surcharge_enabled: enabled }, { onConflict: "region_id" });
    if (error) throw error;
    await adminClient.from("audit_logs").insert({
      id: require("uuid").v4(),
      action: enabled ? "RAIN_SURCHARGE_ENABLED" : "RAIN_SURCHARGE_DISABLED",
      actor_id: req.user.id,
      target_type: "delivery_settings",
      details: { region_id },
    });
    res.json({ success: true, message: `Rain surcharge ${enabled ? "enabled" : "disabled"}.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/delivery/admin/override
const setManualOverride = async (req, res) => {
  try {
    const { region_id, override_fee } = req.body;
    const { error } = await adminClient
      .from("delivery_settings")
      .upsert({ region_id, manual_override_fee: override_fee }, { onConflict: "region_id" });
    if (error) throw error;
    await adminClient.from("audit_logs").insert({
      id: require("uuid").v4(),
      action: override_fee ? "DELIVERY_FEE_OVERRIDE_SET" : "DELIVERY_FEE_OVERRIDE_CLEARED",
      actor_id: req.user.id,
      target_type: "delivery_settings",
      details: { region_id, override_fee },
    });
    res.json({ success: true, message: override_fee ? `Override fee set to ₦${override_fee}.` : "Override cleared." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const haversineDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
const toRad = (deg) => (deg * Math.PI) / 180;

module.exports = { estimateDeliveryFee, calculateDeliveryFee, getDeliverySettings, getAllDeliverySettings, getEffectiveDeliveryRadius, haversineDistance, toggleRainSurcharge, setManualOverride };
