# Intelligent Media Processing Pipeline

A backend system that accepts vehicle image uploads, stores metadata, and asynchronously
runs a set of quality/integrity checks (blur, low light, duplicate detection, OCR + Indian
plate format validation, resolution, screenshot/photo-of-photo heuristics, and a basic
tamper heuristic) — surfaced through a small status/results API.

**Stack:** Node.js + Express (API, queue, orchestration) · MongoDB + Mongoose (persistence)
· Python + OpenCV/Pillow/Tesseract (pixel-level analysis, invoked as a subprocess)
· In-memory queue (custom, no external broker)

---

## 1. Architecture

### 1.1 Service flow

```
Client
  │  POST /api/images/upload  (multipart/form-data, field "image")
  ▼
Express (multer)
  │  1. validate mimetype/size
  │  2. save file to storage/uploads/<uuid>.<ext>
  │  3. insert Image doc {status: "pending"} in MongoDB
  │  4. enqueue {processingId} on the in-memory queue
  │  5. respond 202 immediately with processingId + poll URLs
  ▼
InMemoryQueue (bounded concurrency, e.g. 2 workers)
  │  picks up job when a slot is free
  ▼
imageWorker.js
  │  1. mark Image "processing", bump attempts
  │  2. spawn: python3 src/analysis/analyze.py <path>
  │  3. parse JSON result from stdout
  │  4. cross-check perceptualHash against other DB records (duplicate detection)
  │  5. on success  -> save analysis, mark "completed"
  │     on failure  -> retry (re-enqueue with backoff) up to maxAttempts,
  │                    then mark "failed" with failureReason
  ▼
MongoDB (Image collection: metadata + embedded analysis result)
  ▲
  │  GET /api/images/:id/status   -> lifecycle state
  │  GET /api/images/:id/result   -> full analysis (409 if not completed)
  │  GET /api/images                -> list/filter/paginate
```

### 1.2 Why split Node (orchestration) from Python (analysis)?

The user chose Node/Express/MongoDB for the backend and pure OpenCV/heuristics (no paid
AI APIs) for the checks. Native OpenCV bindings for Node (`opencv4nodejs`) are notoriously
fragile to install (native compilation, version pinning, frequently broken on newer Node).
Rather than fight that, the analysis step shells out to a small, focused Python script via
`child_process.spawn`, which:

- keeps the Node side "boring" (HTTP, queueing, persistence — things Express is good at)
- keeps the analysis side in the ecosystem OpenCV/Tesseract actually target
- gives a clean process boundary: a crash or hang in analysis (e.g. a pathological image)
  can't take down the API process, and is bounded by a subprocess timeout
- is explainable and swappable — analyze.py could be replaced by a real microservice
  (FastAPI + gRPC/HTTP) later with almost no change to the Node-side contract, since it
  already treats analysis as "black box in, JSON out"

The trade-off is subprocess spawn overhead and JSON-over-stdout as an IPC mechanism. Both
are fine at this scale; see §3 for what changes at higher throughput.

### 1.3 Queue strategy

A custom in-memory queue (`src/queue/inMemoryQueue.js`) with:
- bounded concurrency (`QUEUE_CONCURRENCY`, default 2) so N images upload doesn't spawn
  N Python processes simultaneously and thrash CPU
- retry with linear backoff (`attempts * JOB_RETRY_DELAY_MS`) up to `MAX_JOB_ATTEMPTS`
- a startup recovery pass: any Image left in `pending`/`processing` from a previous
  crash is re-enqueued when the server restarts, so a crash doesn't silently strand jobs
  forever (it does NOT survive losing the DB record itself, only the in-memory job list)

This was an explicit choice over Redis/BullMQ/SQS (see the take-home's own list of
acceptable options) to keep local setup to "just run MongoDB" — the assignment states
choice of queue matters less than the reasoning, and reasoning is documented above and
in §3 (Trade-offs) for exactly where this breaks down at scale.

### 1.4 Data modeling

Single `Image` collection (see `src/models/Image.js`) with metadata fields at the top
level and the analysis result as an embedded sub-document. Rationale:
- analysis is always fetched together with the image, never queried independently ->
  no need for a join / separate collection
- `perceptualHash` is duplicated to the top level (out of `analysis.duplicate`) and
  indexed, because duplicate-detection needs to query/scan hashes directly — keeping it
  buried in the analysis blob would mean deserializing every document to compare hashes
- `status` and `createdAt` are indexed since they're the two things list/poll queries
  filter and sort by

### 1.5 Checks implemented (6, exceeds the "at least 4" requirement)

| Check | Method |
|---|---|
| Blur detection | Variance of Laplacian on grayscale image |
| Low light | Mean pixel intensity of grayscale image |
| Duplicate detection | Perceptual hash (`imagehash.phash`) + Hamming distance against existing records, exact-match fast path first |
| OCR + Indian plate format validation | Rotation-aware multi-candidate plate localization (colour-mask + edge-morphology proposals, ranked by `minAreaRect` shape, deskewed via perspective warp, adaptive exposure correction) rather than OCR on the whole frame, then regex match (`^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$`) against sliding-window token concatenations - see §2 for how this evolved through two rounds of real-photo debugging, including a disclosed remaining limitation |
| Resolution validation | Minimum width/height thresholds |
| Screenshot / photo-of-photo heuristics | Missing EXIF + common screen aspect ratios (screenshot signal); large rectangular border near frame edges via Canny + contours (photo-of-photo signal) |
| Editing/tampering heuristic (bonus) | Error Level Analysis (ELA) proxy — re-save at fixed JPEG quality, diff against original |

Every check is explicitly documented in code as a **heuristic**, not a certified detector —
this matches the assignment's framing that the goal is "structuring uncertainty," not
perfect ML accuracy. Each result includes the raw signal (variance, mean, ELA score, etc.)
alongside the boolean verdict so a human reviewer can second-guess the heuristic.

---

## 2. AI Usage Disclosure

I used Claude (Anthropic) to help build this project. Concretely:

**Where AI helped:**
- Scaffolding the overall file/module structure (routes/controllers/queue/worker split)
- Writing the initial draft of `analyze.py`'s checks (Laplacian blur, ELA tamper proxy,
  screenshot heuristics) and the Node subprocess-spawning + retry/backoff logic
- Drafting this README structure

**Where AI output was wrong or needed correction, and how I validated it:**
- The first draft of `analyze.py` returned raw `numpy`/`opencv` boolean and integer types
  (`np.bool_`, `np.int64`) directly in the result dict. `json.dumps()` fails on these —
  I caught this by actually running the script end-to-end against a generated test image
  (`python3 analyze.py /tmp/test.jpg`) rather than trusting it would work, saw the
  `TypeError: Object of type bool is not JSON serializable` traceback, and fixed it by
  explicitly casting every value that crosses the JSON boundary to native Python
  `bool`/`int`/`float`.
- I ran the script against three cases deliberately (a clear plate image, a synthetic
  blurry/low-light image, a corrupt/non-image file) to confirm the blur/brightness/OCR
  checks actually fire correctly and that the error path returns a clean JSON error +
  non-zero exit code (rather than a raw Python traceback on stdout, which would break
  the Node-side JSON parser).
- I wrote and ran real unit tests (`tests/unit.test.js`, `node --test`) for the two
  pieces of pure logic that don't need external infra: Hamming-distance math and the
  in-memory queue's concurrency/retry behavior (including that a throwing job handler
  doesn't wedge the queue). All 6 pass locally.
- I did **not** have MongoDB available in the environment I built this in, so the full
  upload -> queue -> worker -> MongoDB round trip is validated by code review and by the
  fact that every individual component (the Python script, the queue, the Mongoose
  schema) was independently exercised — not by an end-to-end run. This is called out
  explicitly rather than claimed as tested. **Before submitting, run it locally with
  `docker-compose up` and walk through the sample requests in §5 to confirm the full
  path.**

**The plate-OCR pipeline was rewritten after real-world testing exposed it as too naive
— this is the most substantial AI-assisted debugging in the project, and worth detailing
in full:**

The first version ran Tesseract once on the whole frame. It worked on a synthetic
close-up test image, but failed completely on a real photo I tested it with (an
auto-rickshaw where the plate is small relative to a large, high-contrast ad banner
covering most of the frame) — OCR found nothing usable, because it was trying to read
everything at once and the banner text dominated.

I asked Claude to rebuild this as a proper localization-then-OCR pipeline (colour-mask +
edge-based region proposals, ranked, cropped, then OCR'd) rather than accept "OCR the
whole image" as good enough. The first rewrite still failed on the same test photo, and
I made Claude debug it empirically rather than guess at fixes — actually visualizing
candidate boxes drawn on the image, inspecting the raw colour mask as a saved image, and
printing intermediate OCR output at each stage instead of only looking at the final
JSON. That process surfaced three distinct, real bugs, each caught by looking at actual
intermediate output rather than reasoning in the abstract:

1. **Colour candidates ranked below noisy edge candidates.** The plate's own colour mask
   *did* propose the correct region, but ranking mixed it into one pool with noisier
   edge-detected text blobs and sorted only by aspect ratio — a signage-text blob with a
   closer aspect ratio outranked the real plate and pushed it out of the top candidates
   entirely. Fixed by ranking colour-based candidates ahead of edge-based ones, since
   colour is the stronger, more specific signal for a plate.
2. **The plate was merging with the vehicle's yellow bumper trim into one oversized,
   wrong-shaped blob**, because they were physically adjacent with only a hairline gap —
   morphological closing bridged that gap. Confirmed by saving the raw colour mask as an
   image and looking at it directly, which showed the plate and trim as one connected
   white region. Fixed by using a light erosion instead of closing, which breaks thin
   bridges between same-coloured but separate objects without destroying either region.
3. **Wrong Tesseract page-segmentation mode.** Once the crop was correctly isolated,
   `--psm 7` (assume one line) still failed, because this plate — like many two-wheeler/
   auto-rickshaw plates — is two lines stacked, not one. Confirmed by testing multiple
   `--psm` values directly against the isolated crop and comparing output. Fixed by
   trying `--psm 7`, `11`, and `6` per crop and accepting the first one that produces a
   regex-valid plate.

I also caught and fixed a real confidence-calculation bug along the way: Tesseract's
`image_to_data` returns confidence values for non-text structural rows (block/line/
paragraph level) as well as actual words, and the original averaging logic didn't filter
those out, so a result could show a confidence score even when `extractedText` was
`null`. Fixed by only counting confidence from rows with non-empty recognized text.

After all four fixes, I re-ran the pipeline against: the original failing real photo
(now correctly extracts the plate), the original synthetic close-up plate test (still
passes — confirms the rewrite didn't regress the simple case), a blurry/low-light image,
a fully random/textured image with no plate, a blank image, a corrupt file, and a
non-existent path — checking exit codes and JSON shape on each, not just the happy path.
I also re-timed every case, since the multi-candidate approach is inherently slower than
one OCR call: worst case (no plate anywhere, all candidates exhausted) is ~6 seconds,
typical case 1-3 seconds, both comfortably inside the subprocess's 30-second timeout.

This is also a good illustration of a real limitation to be upfront about: this pipeline
was tuned against one specific real photo. It's a heuristic, not a trained plate
detector, and I'd expect it to still fail on plates with unusual colours/angles, heavy
glare, or non-standard layouts. I did not claim "works for all images" as a validated
guarantee — I made it meaningfully more robust than the naive first version and tested
it against a deliberately varied set of cases, which is a different and more honest
claim.

**Second round — a third real photo (shot at an angle, plate shadowed) exposed a
different failure mode, which I chose to keep fixing with heuristics rather than switch
to a trained detector:**

A second real test photo — same rickshaw, different angle (camera held off to the side,
not head-on) — failed to detect the plate at all. Debugging this one empirically
(drawing candidate rectangles on the image, saving intermediate masks, printing OCR
output per preprocessing variant) surfaced two more distinct, real issues:

1. **The plate was tilted ~70-85° in the frame** (nearly vertical in pixel space, due to
   the camera angle), and the existing code measured candidate shape using an
   axis-aligned bounding box — a tilted plate gets measured as "tall and narrow" instead
   of "long and thin," which threw off both filtering and ranking. Fixed by switching to
   `cv2.minAreaRect` (rotation-invariant shape measurement) and adding a proper
   perspective-warp deskew step (`cv2.getPerspectiveTransform` + `warpPerspective`) that
   straightens a candidate to upright before OCR ever sees it, regardless of the original
   tilt angle.
2. **Small, unrelated text fragments from the ad banner coincidentally scored better on
   aspect-ratio ranking than the real (larger) plate region**, pushing the real plate
   outside the candidates actually tried. Confirmed by printing the full ranked candidate
   list with scores and comparing positions. Fixed by raising the minimum candidate area
   threshold, so a few-hundred-pixel text sliver can no longer outrank a real,
   properly-sized plate region purely by chance.

After these fixes, the pipeline correctly located and deskewed the plate on this photo —
but OCR still couldn't read it cleanly, returning `MW12K R1I145` against the actual plate
`MH12K R1145` (two character misreads: H misread as W, one extra inserted I). I
investigated *why* directly: I manually cropped the exact plate region by hand and swept
several brightness-correction strengths against it, which confirmed the crop itself was
significantly underexposed (mean pixel value ~53, versus ~110-130 for a well-lit plate) —
the plate sits in the vehicle's shadow in this photo. I added an adaptive exposure-
correction step (`_auto_brighten`) as a result, tuned by testing several strengths against
this real crop (a moderate ~1.8x correction read measurably better than an aggressive
2.2-2.5x, which blows out local contrast and hurts thresholding) - this is a genuine,
generalizable improvement, not a one-photo hack, since underexposed plates are a common
real-world condition, not specific to this image.

**I'm stating plainly that this particular photo still doesn't produce a validated
plate match after all of the above** — the pipeline now finds the plate, deskews it, and
reads nearly every character correctly, but 2 character-level OCR errors are enough to
fail the strict regex. Closing that last gap would mean either loosening the plate regex
to tolerate common OCR character confusions (a real option, but it trades precision for
recall in a way that deserves its own testing) or accepting that classical heuristics
have a genuine ceiling on a dark, steeply-angled photo like this one — which is exactly
the kind of case a trained detector (e.g. YOLO fine-tuned on plates) would likely handle
better, since it doesn't rely on hand-tuned brightness/geometry assumptions. I was asked
directly whether to switch to YOLO for this and explicitly chose to keep improving the
heuristic path instead, so this remaining gap is a known, disclosed trade-off of that
choice, not an oversight.

After this round I re-ran the full regression set again (both real photos, the synthetic
close-up plate test, blurry/low-light image, random-noise image, blank image, corrupt
file, missing path) to confirm no case regressed, and re-ran all 6 Node unit tests
(still passing). The original, well-lit, head-on rickshaw photo still resolves correctly
and quickly (~1-2s); the new angled/shadowed photo is measurably improved (from "nothing
detected" to "correct region located and 9 of 11 characters read correctly") but not yet
a validated exact match, and I'm reporting that honestly rather than rounding it up to
"fixed."

I used AI as an accelerant for boilerplate and a first draft of heuristics, but every
check's logic, every schema decision, and the retry/recovery design were reviewed and
reasoned through by me, and I adjusted thresholds / fixed the serialization bug myself
rather than accepting the first output.

---

## 3. Trade-offs

**Intentionally simplified:**
- No auth/rate limiting on the API (assignment scope is the pipeline, not auth)
- Duplicate detection near-match fallback is O(n) over all hashed images — fine for a
  take-home dataset size, not for millions of images
- Screenshot/photo-of-photo and tamper detection are cheap heuristics, not trained
  classifiers — explicitly documented as such rather than oversold
- No image resizing/thumbnailing before storage
- **Plate OCR is a rotation-aware classical CV pipeline (colour-mask + edge-morphology
  candidate proposals, `minAreaRect` shape measurement, perspective-warp deskewing,
  adaptive exposure correction), not a trained plate detector.** It correctly reads
  plates in good lighting at most angles, and was verified end-to-end against a
  well-lit, head-on photo. Against a second real photo with a steep camera angle and a
  shadowed plate, it correctly locates and deskews the plate but misreads 2 of 11
  characters (`MW12K R1I145` vs the actual `MH12K R1145`), so it does not report a
  match on that case. This is a disclosed, tested limit, not an untested gap — a trained
  detector (e.g. YOLO fine-tuned on plates) would likely handle this specific case
  better, and was explicitly considered and set aside in favour of continuing to improve
  the heuristic approach (see the AI Usage Disclosure above for the full debugging
  trail).

**What I'd improve with more time:**
- Replace the O(n) duplicate scan with a proper similarity index (BK-tree over Hamming
  distance, or a vector index if moving to embeddings) once dataset size matters
- Add a dedicated, trained screenshot/tamper classifier instead of heuristics — the
  heuristics here will false-positive on e.g. a genuinely square-aspect-ratio field photo
- Structured request/response validation (e.g. zod/joi) instead of ad hoc checks
- Idempotency key on upload to avoid double-processing on client retries
- For plate OCR specifically: either a small amount of regex tolerance for common OCR
  character confusions (H/W, 1/I), or a move to a trained plate detector, to close the
  remaining gap on steeply-angled/shadowed photos described above

**Scalability concerns:**
- The in-memory queue is the biggest one: it doesn't survive a process crash (jobs
  in-flight are lost from the queue, though the DB record remains and gets picked up by
  the startup recovery pass only if the *process* restarts, not if it just dies and stays
  down) and doesn't scale across multiple Node instances (each instance has its own
  queue, so horizontal scaling would double-process or split work incorrectly without
  extra coordination). A real deployment should move to Redis/BullMQ or SQS specifically
  because they're durable and shared across instances — this is the #1 thing I'd change
  before any real traffic.
- Subprocess-per-image (Python spawn) has real overhead (process startup, cold Python
  import). At high throughput this should become a long-lived Python worker process
  (e.g. FastAPI service or a persistent worker pool) that Node talks to over HTTP/gRPC
  instead of spawning a fresh process per image.
- Local disk storage for uploads doesn't work across multiple app instances or survive
  container restarts — needs S3/GCS in a real deployment.

**Failure handling concerns:**
- Retries are same-worker, same-machine — a systemic failure (e.g. Tesseract binary
  missing) will burn through all retries identically every time rather than failing fast.
  A production version would distinguish retryable (transient) vs terminal (config/code)
  errors.
- No dead-letter queue — permanently failed jobs just sit in `failed` status in Mongo;
  fine for manual inspection at this scale, not for alerting/paging at real scale.

---

## 4. Running Instructions

### Option A — Docker Compose (recommended, no local Python/Mongo setup needed)

```bash
docker-compose up --build
```

API available at `http://localhost:4000`. MongoDB and all Python dependencies
(OpenCV, Tesseract, ImageHash) are installed inside the app container.

### Option B — Run locally

Prerequisites: Node.js >= 18, Python 3.9+, MongoDB running locally, Tesseract OCR
installed (`apt install tesseract-ocr` / `brew install tesseract`).

```bash
cp .env.example .env          # adjust MONGO_URI etc. if needed
npm install
pip install -r src/analysis/requirements.txt --break-system-packages
npm start                      # or: npm run dev (nodemon)
```

Optional: `npm run seed` inserts a few synthetic completed/failed records so you can
exercise the status/result/list APIs immediately.

Run unit tests (pure logic, no DB/Python required):
```bash
npm test
```

---

## 5. Sample API Requests / Responses

### Upload an image
```bash
curl -X POST http://localhost:4000/api/images/upload \
  -F "image=@/path/to/vehicle.jpg"
```
```json
{
  "processingId": "b1c2d3e4-...-f6a7",
  "status": "pending",
  "message": "Image accepted and queued for processing.",
  "statusUrl": "/api/images/b1c2d3e4-...-f6a7/status",
  "resultUrl": "/api/images/b1c2d3e4-...-f6a7/result"
}
```

### Poll status
```bash
curl http://localhost:4000/api/images/b1c2d3e4-...-f6a7/status
```
```json
{
  "processingId": "b1c2d3e4-...-f6a7",
  "status": "completed",
  "attempts": 1,
  "maxAttempts": 3,
  "uploadedAt": "2026-07-21T10:00:00.000Z",
  "processingStartedAt": "2026-07-21T10:00:01.200Z",
  "processedAt": "2026-07-21T10:00:02.750Z"
}
```

### Fetch result (once completed)
```bash
curl http://localhost:4000/api/images/b1c2d3e4-...-f6a7/result
```
```json
{
  "processingId": "b1c2d3e4-...-f6a7",
  "originalFilename": "vehicle.jpg",
  "status": "completed",
  "processedAt": "2026-07-21T10:00:02.750Z",
  "analysis": {
    "blur": { "laplacianVariance": 651.15, "threshold": 100, "isBlurry": false },
    "brightness": { "meanBrightness": 197.8, "threshold": 60, "isLowLight": false },
    "duplicate": { "isDuplicate": false, "matchedProcessingId": null, "hashDistance": null },
    "ocr": { "extractedText": "KA20MH1234", "detectedPlate": "KA20MH1234", "isValidPlateFormat": true, "ocrConfidence": 80.0 },
    "dimensions": { "width": 800, "height": 600, "isValidResolution": true },
    "screenshotCheck": { "isLikelyScreenshot": false, "isLikelyPhotoOfPhoto": false, "reasons": [] },
    "editingHeuristics": { "isSuspiciousEdit": false, "elaScore": 0.06, "reasons": [] },
    "issues": [],
    "confidenceScore": 1.0
  }
}
```

### Result requested before processing finishes
```bash
curl http://localhost:4000/api/images/b1c2d3e4-.../result
```
```json
{ "error": "Analysis is not yet available. Current status: processing.", "status": "processing" }
```
(HTTP 409)

### List / filter
```bash
curl "http://localhost:4000/api/images?status=failed&limit=10&page=1"
```

---

## 6. Assumptions

- "Vehicle images from the field" are JPEG/PNG/WEBP, uploaded one at a time via
  multipart form (field name `image`), max 15MB.
- Indian plate format is validated against the standard `SS DD SSS DDDD` pattern
  (state code + RTO code + series + number), tolerant of OCR splitting it into multiple
  word boxes but not tolerant of a completely unreadable/absent plate (reported as
  `isValidPlateFormat: null` when OCR found no text at all, vs `false` when text was
  found but didn't match the pattern).
- "Duplicate" means visually near-identical (perceptual hash within a small Hamming
  distance), not byte-identical file — this catches re-uploads of the same photo even
  after re-compression/resizing, which is the more realistic duplicate scenario for
  field uploads.
