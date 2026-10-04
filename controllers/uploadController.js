const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");

const VOICE_BUCKET = "voice-notes";
const PRODUCT_BUCKET = "product-images";
const DISPUTE_BUCKET = "dispute-evidence";
const REVIEW_BUCKET = "review-photos";
const VENDOR_LOGO_BUCKET = "vendor-logos";
const NOTICE_IMAGE_BUCKET = "notice-images";

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIN_IMAGE_WIDTH = 500;
const MIN_IMAGE_HEIGHT = 500;
const MAX_PRODUCT_IMAGES = 6;
const MAX_DISPUTE_IMAGES = 5;
const MAX_REVIEW_IMAGES = 4;

const ensureBucket = async (bucket, isPublic = false) => {
  const { data: buckets, error: listError } = await adminClient.storage.listBuckets();
  if (listError) throw listError;
  if (!buckets?.some((b) => b.name === bucket)) {
    const { error } = await adminClient.storage.createBucket(bucket, { public: isPublic });
    if (error) throw error;
  }
};

// Lightweight dimension checks without adding a native image-processing dependency.
// We still validate MIME/type, size and minimum dimensions before storage.
const getImageDimensions = (buffer, mimetype) => {
  if (mimetype === "image/png") {
    if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (mimetype === "image/webp") {
    if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
    // Older VP8/VP8L variants are valid images but aren't safely dimension-parsed here.
    return null;
  }

  if (mimetype === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) break;

      const isStartOfFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);

      if (isStartOfFrame && segmentLength >= 7) {
        return {
          height: buffer.readUInt16BE(offset + 3),
          width: buffer.readUInt16BE(offset + 5),
        };
      }
      offset += segmentLength;
    }
  }

  return null;
};

const validateImage = (file, minWidth = MIN_IMAGE_WIDTH, minHeight = MIN_IMAGE_HEIGHT) => {
  if (!file) throw new Error("No image file provided.");
  if (!IMAGE_MIME_TYPES.has(file.mimetype)) {
    throw new Error("Only JPG, PNG, and WebP images are allowed.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error("Each image must be 8 MB or smaller.");
  }

  const dimensions = getImageDimensions(file.buffer, file.mimetype);
  if (!dimensions) {
    throw new Error("The image could not be validated. Please use a standard JPG, PNG, or WebP image.");
  }
  if (dimensions.width < minWidth || dimensions.height < minHeight) {
    throw new Error(`Image is too small. Minimum size is ${minWidth}×${minHeight}px.`);
  }

  return dimensions;
};

const uploadFiles = async ({ bucket, files, prefix, isPublic, maxFiles, minWidth, minHeight }) => {
  if (!files?.length) throw new Error("No image files provided.");
  if (files.length > maxFiles) throw new Error(`You can upload a maximum of ${maxFiles} images at a time.`);

  await ensureBucket(bucket, isPublic);

  const uploaded = [];
  try {
    for (const file of files) {
      validateImage(file, minWidth, minHeight);
      const ext = file.mimetype === "image/png" ? "png" : file.mimetype === "image/webp" ? "webp" : "jpg";
      const path = `${prefix}/${uuidv4()}.${ext}`;

      const { error } = await adminClient.storage
        .from(bucket)
        .upload(path, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (error) throw error;
      uploaded.push(path);
    }
  } catch (err) {
    // Best-effort cleanup if a multi-file upload partially succeeds.
    if (uploaded.length) {
      await adminClient.storage.from(bucket).remove(uploaded).catch(() => {});
    }
    throw err;
  }

  if (isPublic) {
    return uploaded.map((path) => adminClient.storage.from(bucket).getPublicUrl(path).data.publicUrl);
  }

  // Private evidence is stored as a storage reference, not a permanent public URL.
  return uploaded.map((path) => `storage://${bucket}/${path}`);
};

// @route POST /api/uploads/product-images
const uploadProductImages = async (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ success: false, message: "Select at least one product image." });

    const { data: vendor, error: vendorError } = await adminClient
      .from("vendors")
      .select("id, status")
      .eq("user_id", req.user.id)
      .single();

    if (vendorError || !vendor) return res.status(404).json({ success: false, message: "Vendor profile not found." });
    if (vendor.status !== "approved") return res.status(403).json({ success: false, message: "Your vendor account is not approved yet." });

    const urls = await uploadFiles({
      bucket: PRODUCT_BUCKET,
      files: req.files,
      prefix: req.user.id,
      isPublic: true,
      maxFiles: MAX_PRODUCT_IMAGES,
      minWidth: MIN_IMAGE_WIDTH,
      minHeight: MIN_IMAGE_HEIGHT,
    });

    res.json({ success: true, urls });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// @route POST /api/uploads/dispute-evidence
const uploadDisputeEvidence = async (req, res) => {
  try {
    if (req.user.role !== "customer") {
      return res.status(403).json({ success: false, message: "Only customers can upload dispute evidence." });
    }
    if (!req.files?.length) return res.status(400).json({ success: false, message: "Select at least one evidence image." });

    const paths = await uploadFiles({
      bucket: DISPUTE_BUCKET,
      files: req.files,
      prefix: req.user.id,
      isPublic: false,
      maxFiles: MAX_DISPUTE_IMAGES,
      minWidth: 500,
      minHeight: 500,
    });

    res.json({ success: true, paths });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// @route POST /api/uploads/review-photos
// Public bucket — review photos are meant to be visible on the store
// page, same visibility model as product images.
const uploadReviewPhotos = async (req, res) => {
  try {
    if (req.user.role !== "customer") {
      return res.status(403).json({ success: false, message: "Only customers can upload review photos." });
    }
    if (!req.files?.length) return res.status(400).json({ success: false, message: "Select at least one photo." });

    const urls = await uploadFiles({
      bucket: REVIEW_BUCKET,
      files: req.files,
      prefix: req.user.id,
      isPublic: true,
      maxFiles: MAX_REVIEW_IMAGES,
      minWidth: MIN_IMAGE_WIDTH,
      minHeight: MIN_IMAGE_HEIGHT,
    });

    res.json({ success: true, urls });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// @route POST /api/uploads/vendor-logo  [vendor]
// Single image, uploaded and saved to vendors.logo_url in one call —
// unlike product/review photos (which assemble into an array the
// caller then attaches elsewhere), a logo is one dedicated field, so
// there's no reason to make the frontend do two round-trips for it.
const uploadVendorLogo = async (req, res) => {
  try {
    if (req.user.role !== "vendor") {
      return res.status(403).json({ success: false, message: "Only vendors can upload a store logo." });
    }
    if (!req.file) return res.status(400).json({ success: false, message: "Select an image." });

    const { data: vendor } = await adminClient.from("vendors").select("id").eq("user_id", req.user.id).single();
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor profile not found." });

    const urls = await uploadFiles({
      bucket: VENDOR_LOGO_BUCKET,
      files: [req.file],
      prefix: vendor.id,
      isPublic: true,
      maxFiles: 1,
      minWidth: MIN_IMAGE_WIDTH,
      minHeight: MIN_IMAGE_HEIGHT,
    });

    const logo_url = urls[0];
    const { error: updateError } = await adminClient.from("vendors").update({ logo_url }).eq("id", vendor.id);
    if (updateError) throw updateError;

    res.json({ success: true, logo_url });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// @route POST /api/uploads/notice-image
// Admin-only. Two-step flow, same as vendor logo: upload the image
// first to get a URL back, then that URL goes into the actual
// createNotice call — keeps the upload and the notice content as
// separate concerns, same pattern as everywhere else in this file.
const uploadNoticeImage = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Only admins can upload notice images." });
    }
    if (!req.file) return res.status(400).json({ success: false, message: "Select an image." });

    const urls = await uploadFiles({
      bucket: NOTICE_IMAGE_BUCKET,
      files: [req.file],
      prefix: "notice",
      isPublic: true,
      maxFiles: 1,
      // No minWidth/minHeight passed — falls back to the file's
      // default 500×500 floor (see validateImage's defaults), which
      // is a reasonable floor for any announcement image without
      // being as strict as a vendor logo's exact-fit requirements.
    });

    res.json({ success: true, image_url: urls[0] });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Create signed URLs for private dispute evidence after authorization checks.
const signDisputeEvidence = async (references, expiresIn = 3600) => {
  const urls = [];
  for (const ref of references || []) {
    if (!String(ref).startsWith(`storage://${DISPUTE_BUCKET}/`)) {
      urls.push(ref); // Preserve legacy URLs already stored before this upload system.
      continue;
    }
    const path = String(ref).slice(`storage://${DISPUTE_BUCKET}/`.length);
    const { data, error } = await adminClient.storage.from(DISPUTE_BUCKET).createSignedUrl(path, expiresIn);
    if (!error && data?.signedUrl) urls.push(data.signedUrl);
  }
  return urls;
};

const getDisputeEvidenceUrls = signDisputeEvidence;

module.exports = {
  uploadVoiceNote: async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, message: "No audio file provided." });

      // Do not trust the client-provided MIME type alone. WebM files start
      // with the EBML signature 1A45DFA3; checking the bytes prevents an
      // arbitrary file renamed as .webm from being published to storage.
      if (req.file.mimetype !== "audio/webm" || req.file.buffer.length < 4 || req.file.buffer.readUInt32BE(0) !== 0x1A45DFA3) {
        return res.status(400).json({ success: false, message: "Invalid voice note. Please record a WebM audio file." });
      }

      await ensureBucket(VOICE_BUCKET, true);
      const filename = `${req.user.id}/${uuidv4()}.webm`;
      const { error } = await adminClient.storage.from(VOICE_BUCKET).upload(filename, req.file.buffer, {
        contentType: "audio/webm",
        upsert: false,
      });
      if (error) throw error;
      const { data: urlData } = adminClient.storage.from(VOICE_BUCKET).getPublicUrl(filename);
      res.json({ success: true, url: urlData.publicUrl });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  },
  uploadProductImages,
  uploadDisputeEvidence,
  uploadReviewPhotos,
  uploadVendorLogo,
  uploadNoticeImage,
  getDisputeEvidenceUrls,
};
