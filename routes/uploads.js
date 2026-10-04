const express = require("express");
const multer = require("multer");
const router = express.Router();
const {
  uploadVoiceNote,
  uploadProductImages,
  uploadDisputeEvidence,
  uploadReviewPhotos,
  uploadVendorLogo,
  uploadNoticeImage,
} = require("../controllers/uploadController");
const { protect } = require("../middleware/auth");
const { roles } = require("../middleware/roles");

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    // Voice notes are restricted to browser-recorded WebM audio.
    // Image endpoints accept only the image types validated again by
    // uploadController (including magic-byte/dimension checks).
    if (req.path === "/voice-note" || file.fieldname === "audio") {
      if (file.mimetype !== "audio/webm") {
        return cb(new Error("Only WebM audio voice notes are allowed."));
      }
      return cb(null, true);
    }

    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return cb(new Error("Only JPG, PNG, and WebP images are allowed."));
    }

    cb(null, true);
  },
  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 6,
  },
});

router.post("/voice-note", protect, upload.single("audio"), uploadVoiceNote);
router.post("/product-images", protect, upload.array("images", 6), uploadProductImages);
router.post("/dispute-evidence", protect, upload.array("images", 5), uploadDisputeEvidence);
router.post("/review-photos", protect, upload.array("images", 4), uploadReviewPhotos);
router.post("/vendor-logo", protect, upload.single("logo"), uploadVendorLogo);
router.post("/notice-image", protect, roles("admin"), upload.single("image"), uploadNoticeImage);

module.exports = router;
