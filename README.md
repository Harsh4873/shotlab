# ShotLab

ShotLab is a phone-first basketball form lab. It runs MediaPipe Pose Landmarker in the browser, turns 33 body landmarks into repeatable movement metrics, and builds a personal make-versus-miss baseline over time.

Live app: [https://harsh.bet/shotlab/](https://harsh.bet/shotlab/)

The app is deliberately local-first: pose inference and metric calculation happen on the device. Firebase is an optional sync layer for shot summaries and, when Cloud Storage is enabled, original clips.

## What the MVP does

- Records or selects a one-shot video clip from a phone
- Runs the pinned MediaPipe Pose Landmarker Lite model on-device
- Estimates load, upward-motion, release, jump peak, and landing frames
- Lets the player correct the estimated release frame
- Measures release elbow, knee angle at load, hip angle, torso lean, shoulder tilt, base width, jump drift, landing width, landing displacement, and release timing
- Labels shots as made, missed, or unmarked
- Compares the current rep with the player’s own makes
- Finds the strongest emerging make/miss correlation after enough samples
- Saves shots and optional source videos to IndexedDB
- Syncs shot summaries across devices with Google sign-in and Firestore
- Supports opt-in resumable Firebase Storage uploads
- Installs as a PWA and caches the vision model for repeat use

## Important measurement boundaries

ShotLab is not a laboratory 3D motion-capture system. A single phone is most useful for repeatable 2D angles and relative movement when the camera stays fixed.

- Release is currently a pose-kinematics estimate, not ball-separation detection.
- Drift and landing displacement are reported in shoulder-width units, not invented centimeters.
- Arc and automatic make detection are intentionally omitted until a ball/rim detector is added.
- One clean shot per clip is the supported MVP workflow.

For best results, place the phone in landscape at roughly chest height, use a side or 45-degree view, keep the full body and hoop visible, and do not pan the camera.

## Stack

- React 19 + Vinext + Vite
- `@mediapipe/tasks-vision` 1.0.1
- MediaPipe Pose Landmarker Lite float16 v1
- IndexedDB via `idb`
- Firebase Authentication, Firestore, and optional Cloud Storage
- Vitest for deterministic geometry and phase tests
- Static GitHub Pages deployment at `harsh.bet/shotlab/`

## Local development

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

The Firebase web config in this repository is public client configuration for the dedicated `shotlab-harsh4873` project. Access is enforced by Firebase Authentication and the checked-in security rules, not by hiding the API key.

Useful checks:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run build:pages
```

Pushing `main` runs the GitHub Pages workflow. The project intentionally has no `CNAME`; the `harsh.bet` apex repository supplies the shared custom domain and GitHub serves this app at `/shotlab/`.

## Firebase

The default project is declared in `.firebaserc`. Firestore and Authentication are already represented as code in `firebase.json`.

```bash
firebase deploy --only auth,firestore:rules
```

The OAuth brand's support email is deliberately not committed — it is a personal address, and this
repository is public. It is set once in the Google Cloud console under APIs & Services → OAuth
consent screen, which is the value the consent screen actually shows. `firebase deploy --only auth`
therefore leaves the existing support email in place rather than declaring it here.

Cloud Storage for Firebase requires the Blaze pay-as-you-go plan for new/default buckets. Shot summaries still sync through Firestore without raw-video storage. After enabling a bucket, deploy the owner-only video rules:

```bash
firebase deploy --only storage
```

Data layout:

```text
Firestore: users/{uid}/shots/{shotId}
Storage:   users/{uid}/videos/{shotId}/{videoId}
```

Full pose-frame sequences stay local and are excluded from Firestore writes.

## Analysis pipeline

```text
video frame
  → MediaPipe worker
  → 33 normalized + world landmarks
  → side selection and phase detection
  → geometric metrics
  → local shot record
  → optional Firestore summary sync
```

The worker tries a GPU delegate first and falls back to CPU. Analysis is serialized one frame at a time so phones do not build an inference queue.

## Roadmap

The next meaningful vision upgrade is a small basketball/rim detector and persistent tracker. That will replace the pose-only release estimate, add ball arc, and make automatic make/miss tagging possible. The shared frame types already reserve ball and rim tracking points for that phase.

Longer-term work can add multi-shot clip segmentation, calibration, multiview 3D analysis, session exports, and coaching experiments based on personal outcome correlations.

## License

MIT
