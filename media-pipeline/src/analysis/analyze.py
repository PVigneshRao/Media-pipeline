#!/usr/bin/env python3
"""
analyze.py

Runs all image-quality / integrity checks on a single image and prints a single
JSON object to stdout. Designed to be called as a subprocess from the Node.js
worker (see src/workers/imageWorker.js) so that Node can own orchestration
(queueing, retries, persistence) while Python + OpenCV own the actual pixel
analysis, which is where OpenCV's ecosystem is strongest.

Usage:
    python3 analyze.py <absolute_image_path>

Output (stdout): a single JSON object. Any diagnostic/debug output MUST go to
stderr, never stdout, since Node parses stdout as JSON.

Exit codes:
    0 - analysis completed (even if individual checks degraded gracefully)
    1 - unrecoverable error (unreadable/corrupt image, bad path, etc.)
"""

import sys
import json
import os
import re

import numpy as np
import cv2
from PIL import Image, ExifTags

# OCR and perceptual hashing are optional at the module level: if the
# underlying binary/library isn't installed we still want the rest of the
# checks (blur, brightness, dimensions, screenshot heuristics, ELA) to run
# and report OCR/hash as "unavailable" rather than failing the whole job.
try:
    import pytesseract
    TESSERACT_AVAILABLE = True
except ImportError:
    TESSERACT_AVAILABLE = False

try:
    import imagehash
    IMAGEHASH_AVAILABLE = True
except ImportError:
    IMAGEHASH_AVAILABLE = False

# Indian vehicle registration plate format, e.g. "KA20MH1234", "KA 20 MH 1234".
# State(2 letters) + RTO code(1-2 digits) + series(1-3 letters) + number(4 digits)
PLATE_REGEX = re.compile(r'^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$')
# Same pattern, unanchored - used as a fallback to pull a valid plate out of a
# candidate that has stray noise glued directly onto it with no separating
# space, e.g. a frame/screw digit picked up by the crop ("28MH12NW8556") or a
# stray character from adjacent text ("MH12NW8556J"). See _find_plate_in_words.
PLATE_REGEX_SEARCH = re.compile(r'[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}')

# Target aspect ratios (width/height): a standard single-line Indian plate
# is roughly 4.3-5:1, but two-line plates (common on two-wheelers, autos,
# and this rickshaw's rear plate) are closer to 1.8-2.2:1. Both are treated
# as equally plausible when ranking candidates - only the ranking is soft,
# aspect is never a hard filter.
PLATE_TARGET_ASPECTS = (4.5, 2.0)
MAX_PLATE_CANDIDATES = 20


def _aspect_rank_score(aspect):
    """Distance to whichever plausible plate aspect (single- or two-line) is closer."""
    return min(abs(aspect - t) for t in PLATE_TARGET_ASPECTS)

BLUR_LAPLACIAN_THRESHOLD = float(os.environ.get('BLUR_LAPLACIAN_THRESHOLD', 100))
LOW_LIGHT_MEAN_THRESHOLD = float(os.environ.get('LOW_LIGHT_MEAN_THRESHOLD', 60))
MIN_WIDTH = int(os.environ.get('MIN_WIDTH', 400))
MIN_HEIGHT = int(os.environ.get('MIN_HEIGHT', 300))


def log(msg):
    print(msg, file=sys.stderr)


def check_blur(gray):
    variance = cv2.Laplacian(gray, cv2.CV_64F).var()
    return {
        'laplacianVariance': round(float(variance), 2),
        'threshold': BLUR_LAPLACIAN_THRESHOLD,
        'isBlurry': bool(variance < BLUR_LAPLACIAN_THRESHOLD),
    }


def check_brightness(gray):
    mean_brightness = float(np.mean(gray))
    return {
        'meanBrightness': round(mean_brightness, 2),
        'threshold': LOW_LIGHT_MEAN_THRESHOLD,
        'isLowLight': bool(mean_brightness < LOW_LIGHT_MEAN_THRESHOLD),
    }


def check_dimensions(width, height):
    width, height = int(width), int(height)
    return {
        'width': width,
        'height': height,
        'isValidResolution': bool(width >= MIN_WIDTH and height >= MIN_HEIGHT),
    }


def compute_perceptual_hash(pil_img):
    if not IMAGEHASH_AVAILABLE:
        return None
    try:
        return str(imagehash.phash(pil_img))
    except Exception as e:
        log(f'perceptual hash failed: {e}')
        return None


def _rotated_rect_iou_proxy(rect_a, rect_b):
    """
    Cheap overlap proxy for two minAreaRect tuples, used only for
    deduplication (not exact IoU - computing true rotated-rect IoU is
    overkill here). Compares centre distance relative to the rects' sizes;
    close centres with similar size are treated as the same region.
    """
    (cxa, cya), (wa, ha), _ = rect_a
    (cxb, cyb), (wb, hb), _ = rect_b
    center_dist = ((cxa - cxb) ** 2 + (cya - cyb) ** 2) ** 0.5
    avg_size = ((wa + ha) / 2 + (wb + hb) / 2) / 2
    return center_dist < avg_size * 0.5


def find_plate_candidate_rects(bgr_img):
    """
    Proposes ROTATED rectangular regions likely to contain a vehicle plate.

    Earlier versions of this function used axis-aligned bounding boxes
    (cv2.boundingRect) and filtered/ranked by width/height of that box. That
    works fine for a plate photographed roughly head-on, but breaks down
    when the camera is angled so the plate appears tilted in-frame (e.g.
    a photo taken from the side/below) - a tilted plate's axis-aligned
    bounding box has a completely different, distorted aspect ratio from
    the plate's *actual* shape, which caused real candidates to be
    mis-ranked or filtered out entirely on an angled test photo.

    Using cv2.minAreaRect instead measures each contour's true long/short
    side lengths regardless of rotation, so a plate tilted at any angle is
    still correctly recognised as "long and thin" - the aspect ratio
    calculation becomes rotation-invariant.

    Two proposal strategies, as before:
    1. Colour masking (plate-typical yellow/white) - stronger, tried first.
    2. Edge + morphological closing - noisier, fills remaining slots.

    Returns a list of cv2.minAreaRect tuples: ((cx, cy), (w, h), angle).
    """
    h, w = bgr_img.shape[:2]
    img_area = h * w

    def rects_from_mask(mask):
        found = []
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in contours:
            if cv2.contourArea(c) < 30:
                continue
            rect = cv2.minAreaRect(c)
            (_, _), (rw, rh), _ = rect
            if rw == 0 or rh == 0:
                continue
            long_side, short_side = max(rw, rh), min(rw, rh)
            area = rw * rh
            aspect = long_side / short_side
            # Loose bounds: plates are small-to-medium relative to the whole
            # photo and noticeably longer than wide, but we stay generous
            # here since ranking (not filtering) does most of the work.
            # The lower area bound matters more than it looks: small text
            # fragments from unrelated signage/banners can coincidentally
            # have a plate-like aspect ratio too, and with too low a floor
            # they out-rank the real (larger) plate purely by chance - a
            # real plate at typical photo distance is a meaningfully-sized
            # solid rectangle, not a sliver a few hundred pixels large.
            if 0.002 * img_area < area < 0.25 * img_area and 1.5 < aspect < 7.0:
                found.append(rect)
        found.sort(key=lambda r: _aspect_rank_score(max(r[1]) / min(r[1])))
        return found

    color_rects, edge_rects = [], []

    try:
        hsv = cv2.cvtColor(bgr_img, cv2.COLOR_BGR2HSV)
        yellow_mask = cv2.inRange(hsv, (15, 70, 70), (35, 255, 255))
        white_mask = cv2.inRange(hsv, (0, 0, 165), (180, 45, 255))
        # Try both the raw mask and a lightly eroded version as separate
        # proposal passes, rather than always eroding: erosion helps break
        # a plate that's fused to same-coloured adjacent trim, but can also
        # fragment a plate that's already thin due to being photographed at
        # a steep angle. Trying both and letting ranking/OCR sort out which
        # candidate is real is more robust than committing to one.
        erode_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        yellow_eroded = cv2.erode(yellow_mask, erode_kernel)
        white_eroded = cv2.erode(white_mask, erode_kernel)
        color_rects = (
            rects_from_mask(yellow_mask) + rects_from_mask(white_mask)
            + rects_from_mask(yellow_eroded) + rects_from_mask(white_eroded)
        )
        color_rects.sort(key=lambda r: _aspect_rank_score(max(r[1]) / min(r[1])))
    except Exception as e:
        log(f'colour-mask plate localization failed: {e}')

    try:
        gray = cv2.cvtColor(bgr_img, cv2.COLOR_BGR2GRAY)
        gray_blur = cv2.bilateralFilter(gray, 11, 17, 17)
        edges = cv2.Canny(gray_blur, 30, 200)
        closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (19, 3)))
        edge_rects = rects_from_mask(closed)
    except Exception as e:
        log(f'edge-based plate localization failed: {e}')

    deduped = []
    for rect in color_rects + edge_rects:
        if not any(_rotated_rect_iou_proxy(rect, kept) for kept in deduped):
            deduped.append(rect)

    return deduped[:MAX_PLATE_CANDIDATES]


def _deskew_crop(bgr_img, rect, pad_ratio=0.12, target_height=150):
    """
    Extracts and straightens a rotated-rectangle region into a normal
    upright image, using a perspective warp rather than a simple axis-
    aligned crop. This is what actually fixes OCR on tilted plates: OCR
    engines expect roughly horizontal text, so even a perfectly-located
    but still-tilted crop reads poorly. warpPerspective maps the four
    corners of the (possibly rotated) plate rectangle onto a clean
    horizontal target rectangle, correcting the tilt before OCR ever sees it.
    """
    (cx, cy), (rw, rh), angle = rect
    long_side, short_side = max(rw, rh), min(rw, rh)
    if long_side <= 0 or short_side <= 0:
        return None

    # Pad by working in a slightly enlarged virtual rect, since OpenCV's
    # rotated-rect angle convention varies by version/orientation - padding
    # the box itself (rather than the post-warp image) keeps the warp
    # consistent regardless of orientation.
    padded_rect = ((cx, cy), (rw * (1 + pad_ratio), rh * (1 + pad_ratio)), angle)
    box_points = cv2.boxPoints(padded_rect).astype('float32')

    out_w, out_h = int(long_side * (1 + pad_ratio)), int(short_side * (1 + pad_ratio))
    if out_w <= 0 or out_h <= 0:
        return None

    # boxPoints returns corners in a consistent order but not necessarily
    # starting at "top-left of the plate as we'd want to read it" - order
    # them by summing/differencing coordinates (standard technique) so the
    # perspective map is always: box corner -> matching corner of the
    # target upright rectangle, regardless of the source rect's rotation.
    s = box_points.sum(axis=1)
    diff = np.diff(box_points, axis=1).flatten()
    ordered = np.zeros((4, 2), dtype='float32')
    ordered[0] = box_points[np.argmin(s)]        # top-left
    ordered[2] = box_points[np.argmax(s)]        # bottom-right
    ordered[1] = box_points[np.argmin(diff)]     # top-right
    ordered[3] = box_points[np.argmax(diff)]     # bottom-left

    # If the rect is taller than wide (angle convention made rh the long
    # side), the ordering above still yields a valid quadrilateral, but we
    # want the OCR crop's long axis horizontal - swap output dims to match
    # whichever source side is actually longer.
    src_top_len = np.linalg.norm(ordered[1] - ordered[0])
    src_side_len = np.linalg.norm(ordered[3] - ordered[0])
    if src_side_len > src_top_len:
        out_w, out_h = out_h, out_w

    dst = np.array([[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]], dtype='float32')

    try:
        m = cv2.getPerspectiveTransform(ordered, dst)
        warped = cv2.warpPerspective(bgr_img, m, (out_w, out_h))
    except Exception as e:
        log(f'perspective deskew failed: {e}')
        return None

    if warped.size == 0:
        return None

    # Normalize to a consistent height for OCR, same reasoning as before:
    # tesseract does better at a predictable target size than whatever
    # resolution the candidate happened to be detected at.
    h = warped.shape[0]
    if h > 0:
        scale = target_height / h
        warped = cv2.resize(warped, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    return warped


def _ocr_words_and_confidence(gray_or_thresh_img, psm=7):
    """
    Runs pytesseract on a single preprocessed image and returns (words,
    avg_confidence). Only rows with non-empty recognized text are counted
    toward the confidence average - Tesseract's image_to_data also returns
    page/block/paragraph/line-level rows with their own (often positive)
    confidence values but no text, which previously polluted the average.
    """
    config = f'--psm {psm} -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    data = pytesseract.image_to_data(gray_or_thresh_img, config=config, output_type=pytesseract.Output.DICT)

    words, confs = [], []
    for text, conf in zip(data.get('text', []), data.get('conf', [])):
        text = text.strip()
        if not text:
            continue
        words.append(text)
        try:
            conf_val = int(float(conf))
        except (ValueError, TypeError):
            conf_val = -1
        if conf_val >= 0:
            confs.append(conf_val)

    avg_conf = round(sum(confs) / len(confs), 2) if confs else None
    return words, avg_conf


def _find_plate_in_words(words):
    """Try single tokens and short concatenated runs against the plate regex,
    since Tesseract commonly splits a plate into 2-4 separate word boxes.

    Two passes over the same candidate list:
    1. Exact match - the whole (cleaned) candidate IS the plate. Tried
       first because it's the safer of the two: there's no risk of
       matching a false-positive substring buried inside unrelated text.
    2. Substring search - a valid plate appears somewhere inside the
       candidate, with extra noise glued directly onto it (no separating
       space) elsewhere in the token. This is what recovers a case like
       OCR output "28 MH12N W8556 J": the windowed-join candidate
       "28MH12NW8556J" fails the exact match (leading "28"/trailing "J"
       are noise), but a substring search on that same candidate finds
       "MH12NW8556" inside it.
    """
    candidates = list(words) + [''.join(words)]
    for i in range(len(words)):
        for j in range(i + 1, min(i + 5, len(words)) + 1):
            candidates.append(''.join(words[i:j]))

    normalized_candidates = [re.sub(r'[^A-Za-z0-9]', '', c).upper() for c in candidates]

    for normalized in normalized_candidates:
        if PLATE_REGEX.match(normalized):
            return normalized

    for normalized in normalized_candidates:
        match = PLATE_REGEX_SEARCH.search(normalized)
        if match:
            return match.group(0)

    return None


def _crop_and_upscale(bgr_img, box, pad_ratio=0.08, min_height=150):
    """Axis-aligned crop, kept for the full-frame fallback path (a plain
    (x, y, w, h) box, not a rotated rect - the whole-frame fallback doesn't
    need deskewing since it isn't proposing a rotated region)."""
    h, w = bgr_img.shape[:2]
    x, y, cw, ch = box
    pad_x, pad_y = int(cw * pad_ratio), int(ch * pad_ratio)
    x0, y0 = max(0, x - pad_x), max(0, y - pad_y)
    x1, y1 = min(w, x + cw + pad_x), min(h, y + ch + pad_y)
    crop = bgr_img[y0:y1, x0:x1]

    if crop.size == 0:
        return None

    crop_h = crop.shape[0]
    if crop_h > 0:
        scale = min_height / crop_h
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    return crop


def _auto_brighten(gray):
    """
    Normalizes exposure toward a target mean brightness before thresholding.
    Real vehicle plates are frequently shadowed (under a bumper, in a wheel
    well, or simply in overcast/backlit conditions) - testing showed a
    correctly-located, correctly-deskewed plate crop can still fail OCR
    outright when the crop itself is too dark, independent of localization
    accuracy. This targets exposure specifically, which contrast-only
    methods (CLAHE) don't fully address.

    The correction is deliberately capped at a moderate strength: testing
    against a real underexposed plate photo showed a moderate correction
    (~1.8x) read noticeably better than an aggressive one (2.2-2.5x) -
    over-brightening blows out local contrast between the plate's
    background and its characters, which hurts thresholding more than the
    extra brightness helps.
    """
    current_mean = float(np.mean(gray))
    if current_mean <= 0:
        return gray
    target_mean = 100.0
    if current_mean >= target_mean * 0.9:
        return gray  # already bright enough - don't over-brighten and blow out highlights
    alpha = min(1.9, target_mean / current_mean)
    return cv2.convertScaleAbs(gray, alpha=alpha, beta=12)


def _ocr_crop_for_plate(bgr_crop):
    """
    Runs OCR on one candidate crop across preprocessing variants AND
    page-segmentation modes, since no single combination wins across every
    plate: a close-up single-line plate reads best with `--psm 7`, while a
    two-line plate (common on autos/two-wheelers) needs `--psm 11` or `6`
    to be read as separate lines rather than forced into one, and a
    shadowed/underexposed plate needs brightness correction before either
    threshold variant can find its text at all. Returns on the first
    regex-valid plate found (good enough beats optimal, for speed),
    otherwise falls back to whatever text got the highest confidence.
    """
    gray = cv2.cvtColor(bgr_crop, cv2.COLOR_BGR2GRAY)
    gray = _auto_brighten(gray)

    variants = []
    try:
        denoised = cv2.bilateralFilter(gray, 7, 50, 50)
        _, otsu = cv2.threshold(denoised, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        variants.append(otsu)
    except Exception:
        pass
    try:
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
        adaptive = cv2.adaptiveThreshold(
            clahe, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 10
        )
        variants.append(adaptive)
    except Exception:
        pass
    if not variants:
        variants = [gray]

    best_fallback = None
    # Accumulates words across every (variant, psm) attempt on this crop, in
    # order encountered. The exact-match/substring-search logic in
    # _find_plate_in_words already recovers a plate whose tokens all show up
    # in ONE OCR call (e.g. ['28','MH12N','W8556','J'] from a single call).
    # But in practice the tokens are sometimes split across DIFFERENT calls
    # instead - one preprocessing variant reads "28 MH12N" (misses the
    # tail), another reads "W8556 J" (misses the head) - and neither call
    # alone has enough tokens to reconstruct the plate. Retrying the match
    # against the merged token stream from every attempt on this crop
    # catches that case.
    all_words_seen = []

    for variant in variants:
        for psm in (7, 11, 6):
            try:
                words, conf = _ocr_words_and_confidence(variant, psm=psm)
            except Exception as e:
                log(f'OCR attempt failed on a candidate crop (psm {psm}): {e}')
                continue

            if not words:
                continue

            all_words_seen.extend(words)

            plate = _find_plate_in_words(words)
            full_text = ' '.join(words)

            if plate:
                return {'plate': plate, 'confidence': conf, 'text': full_text, 'words': all_words_seen}

            if best_fallback is None or (conf or 0) > (best_fallback['confidence'] or 0):
                best_fallback = {'plate': None, 'confidence': conf, 'text': full_text}

    # Nothing matched within a single attempt - try the merged token stream
    # from every attempt on this crop before giving up on it entirely.
    merged_plate = _find_plate_in_words(all_words_seen)
    if merged_plate:
        merged_conf = best_fallback['confidence'] if best_fallback else None
        return {
            'plate': merged_plate,
            'confidence': merged_conf,
            'text': ' '.join(all_words_seen),
            'words': all_words_seen,
        }

    if best_fallback is not None:
        best_fallback['words'] = all_words_seen
    return best_fallback


def run_ocr(bgr_img):
    """
    Locates and reads a vehicle plate using a multi-candidate pipeline
    instead of running OCR once on the whole frame:

      1. Propose ROTATED candidate regions via colour-mask + edge-
         morphology (find_plate_candidate_rects), ranked by how plate-like
         their rotation-invariant aspect ratio is.
      2. Deskew each candidate (perspective-warp it upright regardless of
         how tilted it was in the original photo), then OCR it looking for
         a regex-valid plate; stop early on the first hit.
      3. Always OCR the full frame too, as a fallback/last resort (covers
         close-up plate photos where the whole image already *is* the
         plate region, and images where the candidate proposals miss).

    This generalizes across image types precisely because it doesn't
    assume one specific framing or camera angle - a close-up plate crop, a
    full vehicle photo with a small plate shot head-on, or the same shot
    taken at a steep angle all go through the same rotation-aware
    candidate + deskew + fallback path.
    """
    if not TESSERACT_AVAILABLE:
        return {
            'extractedText': None,
            'detectedPlate': None,
            'isValidPlateFormat': None,
            'ocrConfidence': None,
            'note': 'pytesseract/tesseract-ocr not installed - OCR skipped',
        }

    h, w = bgr_img.shape[:2]
    best_overall = None
    all_texts = []
    # Words from every crop attempted (candidate regions + full-frame
    # fallback), in order. A plate can be split not just across
    # preprocessing variants of the *same* crop (handled inside
    # _ocr_crop_for_plate) but across *different* candidate crops too -
    # e.g. a slightly-off region proposal reads part of the plate, while
    # another proposal or the full-frame fallback reads the rest. Keeping
    # a global pool lets a final merged pass catch that case.
    all_words_global = []

    try:
        candidate_rects = find_plate_candidate_rects(bgr_img)
    except Exception as e:
        log(f'plate candidate proposal failed: {e}')
        candidate_rects = []

    try:
        for rect in candidate_rects:
            crop = _deskew_crop(bgr_img, rect)
            if crop is None:
                continue
            result = _ocr_crop_for_plate(crop)
            if result is None:
                continue
            if result.get('text'):
                all_texts.append(result['text'])
            if result.get('words'):
                all_words_global.extend(result['words'])
            if result.get('plate'):
                # A regex-valid plate is already a strong, specific signal
                # (the pattern is strict enough that a false positive is
                # unlikely) - stop scanning further candidates rather than
                # spending time chasing marginally higher OCR confidence.
                best_overall = result
                break

        # Always also try the full frame too if no candidate produced a
        # valid plate - covers close-up plate photos where the whole image
        # already *is* the plate region, and cases where candidate
        # proposals missed the plate entirely.
        if best_overall is None:
            full_frame_result = _ocr_crop_for_plate(bgr_img if min(h, w) < 150 else _crop_and_upscale(bgr_img, (0, 0, w, h), pad_ratio=0, min_height=min(h, 400)))
            if full_frame_result:
                if full_frame_result.get('text'):
                    all_texts.append(full_frame_result['text'])
                if full_frame_result.get('words'):
                    all_words_global.extend(full_frame_result['words'])
                if full_frame_result.get('plate'):
                    best_overall = full_frame_result

        # Last resort: nothing found a valid plate on its own, but the
        # fragments might still be sitting there split across different
        # crops/attempts (e.g. "28 MH12N" from one region, "W8556 J" from
        # another). Try the full merged token pool before giving up.
        if best_overall is None and all_words_global:
            merged_plate = _find_plate_in_words(all_words_global)
            if merged_plate:
                best_overall = {'plate': merged_plate, 'confidence': None, 'text': ' '.join(all_words_global)}
    except Exception as e:
        log(f'OCR pipeline failed: {e}')

    # Dedupe while preserving order, then join for the extractedText field.
    seen = set()
    ordered_unique_texts = []
    for t in all_texts:
        if t not in seen:
            seen.add(t)
            ordered_unique_texts.append(t)
    full_text = ' | '.join(ordered_unique_texts)[:500] if ordered_unique_texts else None

    detected_plate = best_overall['plate'] if best_overall else None

    return {
        'extractedText': full_text,
        'detectedPlate': detected_plate,
        'isValidPlateFormat': bool(detected_plate) if full_text else None,
        'ocrConfidence': best_overall['confidence'] if best_overall else None,
    }


def check_screenshot_heuristics(pil_img, width, height):
    """
    Heuristic (NOT ML-grade) screenshot / photo-of-photo detector.

    Signals used:
    1. Missing EXIF data - real camera photos almost always carry EXIF
       (make/model/exposure); screenshots and re-saved/re-compressed images
       frequently have none.
    2. Common screen/device aspect ratios (16:9, 4:3 exact, 19.5:9, 21:9 etc.)
       are more typical of screen captures than handheld field photos.
    3. Photo-of-photo proxy: a very sharp rectangular border/frame detected via
       Canny edges + contour analysis near the image boundary, which often
       shows up when someone photographs a printed photo or another screen.

    These are intentionally cheap, explainable heuristics rather than a
    trained classifier - see README for why, and what a production version
    would add (a dedicated CNN classifier, or checking for moire patterns).
    """
    reasons = []
    is_likely_screenshot = False
    is_likely_photo_of_photo = False

    try:
        exif = pil_img._getexif()
    except Exception:
        exif = None

    if not exif:
        reasons.append('no EXIF metadata present')
        is_likely_screenshot = True

    common_ratios = [16 / 9, 4 / 3, 19.5 / 9, 21 / 9, 3 / 2, 1.0]
    if height > 0:
        ratio = width / height
        for r in common_ratios:
            if abs(ratio - r) < 0.01:
                reasons.append(f'aspect ratio {ratio:.3f} matches a common screen ratio ({r:.3f})')
                is_likely_screenshot = True
                break

    try:
        cv_img = cv2.cvtColor(np.array(pil_img.convert('RGB')), cv2.COLOR_RGB2BGR)
        gray = cv2.cvtColor(cv_img, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 50, 150)
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        img_area = width * height
        for c in contours:
            x, y, w, h = cv2.boundingRect(c)
            area = w * h
            # A large rectangular contour that hugs most of the frame and sits
            # near the image edges suggests a photographed screen/photo border.
            if area > 0.6 * img_area and x < width * 0.05 and y < height * 0.05:
                reasons.append('large rectangular border detected near image edges')
                is_likely_photo_of_photo = True
                break
    except Exception as e:
        log(f'photo-of-photo heuristic failed: {e}')

    return {
        'isLikelyScreenshot': is_likely_screenshot,
        'isLikelyPhotoOfPhoto': is_likely_photo_of_photo,
        'reasons': reasons,
    }


def check_editing_heuristics(image_path, pil_img):
    """
    Cheap Error Level Analysis (ELA) proxy for "does this look edited".

    Re-saves the image at a fixed JPEG quality and diffs it against the
    original. Regions that were edited/composited after the last real save
    tend to show a different (usually higher) error level than untouched
    regions, because they haven't been through the same compression history.

    This is a coarse, well-known heuristic (not forensic-grade) - false
    positives are common on already heavily-compressed or resized images.
    We report a single aggregate score plus flag only when it's a clear
    outlier, and we say so explicitly in the output/README rather than
    presenting it as a reliable tamper-detector.
    """
    try:
        resaved_path = image_path + '.__ela_tmp.jpg'
        rgb = pil_img.convert('RGB')
        rgb.save(resaved_path, 'JPEG', quality=90)
        resaved = Image.open(resaved_path)

        diff = np.array(rgb, dtype=np.int16) - np.array(resaved, dtype=np.int16)
        ela_score = float(np.mean(np.abs(diff)))

        os.remove(resaved_path)

        # Threshold picked empirically as "clearly higher than typical
        # single-generation JPEG re-save noise" - documented as a heuristic,
        # not a validated forensic threshold.
        is_suspicious = ela_score > 15.0
        reasons = []
        if is_suspicious:
            reasons.append(f'ELA mean error {ela_score:.2f} exceeds heuristic threshold of 15.0')

        return {
            'isSuspiciousEdit': is_suspicious,
            'elaScore': round(ela_score, 2),
            'reasons': reasons,
        }
    except Exception as e:
        log(f'ELA check failed: {e}')
        return {'isSuspiciousEdit': None, 'elaScore': None, 'reasons': [f'ELA error: {e}']}


def build_issues_list(blur, brightness, dimensions, ocr, screenshot, editing):
    issues = []
    if blur.get('isBlurry'):
        issues.append('blurry_image')
    if brightness.get('isLowLight'):
        issues.append('low_light')
    if not dimensions.get('isValidResolution'):
        issues.append('resolution_too_low')
    if ocr.get('isValidPlateFormat') is False:
        issues.append('invalid_or_missing_plate_format')
    if screenshot.get('isLikelyScreenshot'):
        issues.append('possible_screenshot')
    if screenshot.get('isLikelyPhotoOfPhoto'):
        issues.append('possible_photo_of_photo')
    if editing.get('isSuspiciousEdit'):
        issues.append('possible_tampering')
    return issues


def compute_confidence(issues):
    # Simple, explainable scoring: start high, dock points per distinct issue.
    # Not a calibrated probability - explicitly a heuristic (see README).
    score = 1.0 - (0.12 * len(issues))
    return round(max(0.1, min(1.0, score)), 2)


def main():
    if len(sys.argv) != 2:
        print(json.dumps({'error': 'usage: analyze.py <image_path>'}), file=sys.stderr)
        sys.exit(1)

    image_path = sys.argv[1]

    if not os.path.isfile(image_path):
        print(json.dumps({'error': f'file not found: {image_path}'}))
        sys.exit(1)

    bgr_img = cv2.imread(image_path)
    if bgr_img is None:
        print(json.dumps({'error': 'unreadable or corrupt image file'}))
        sys.exit(1)

    try:
        pil_img = Image.open(image_path)
    except Exception as e:
        print(json.dumps({'error': f'PIL could not open image: {e}'}))
        sys.exit(1)

    height, width = bgr_img.shape[:2]
    gray = cv2.cvtColor(bgr_img, cv2.COLOR_BGR2GRAY)

    blur = check_blur(gray)
    brightness = check_brightness(gray)
    dimensions = check_dimensions(width, height)
    phash = compute_perceptual_hash(pil_img)
    ocr = run_ocr(bgr_img)
    screenshot = check_screenshot_heuristics(pil_img, width, height)
    editing = check_editing_heuristics(image_path, pil_img)

    issues = build_issues_list(blur, brightness, dimensions, ocr, screenshot, editing)
    confidence = compute_confidence(issues)

    result = {
        'blur': blur,
        'brightness': brightness,
        'dimensions': dimensions,
        'ocr': ocr,
        'screenshotCheck': screenshot,
        'editingHeuristics': editing,
        'perceptualHash': phash,
        'issues': issues,
        'confidenceScore': confidence,
    }

    print(json.dumps(result))
    sys.exit(0)


if __name__ == '__main__':
    main()
